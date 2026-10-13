// ============================================================================
// RunManager（P2：事件先持久化再扇出；方案 §8）
//
// - 事件顺序：execute 循环内 await persistence.appendEvent → 拿到 eventId
//   （Redis Stream entry id）→ 再扇出内存订阅者。SSE 的 id: 帧即此游标，
//   断线重连凭它回放（GET /threads/:id/events）
// - run 与 SSE 连接解耦：订阅者断开只是退订，run 继续执行至终态（§8.3/D6）
// - 每 thread 同时至多 1 个活跃 run（§5.1 约束，409）
// - 进程级并发闸门 RAG_MAX_CONCURRENT_RUNS（§8.4，429）
// - 超时 RAG_RUN_TIMEOUT_MS 强制 abort → RUN_ERROR{code:"timeout"}；
//   显式取消 → RUN_ERROR{code:"cancelled"}
// ============================================================================

import { HumanMessage } from '@langchain/core/messages';
import { EventType, type Event as AguiEvent } from '@ag-ui/core';
import { getAgent } from './agentService.js';
import { translateRun, type TranslatableRunStream } from './agui/translator.js';
import type { Persistence } from './persistence/types.js';
import {
    withCozeLoopSpan,
    setSpanInput,
    setSpanOutput,
    getLangChainTracingCallbacks,
    type Span,
} from '@langchain-rag/rag';

export type RunStatus = 'running' | 'finished' | 'error' | 'cancelled' | 'timeout';

/** 订阅者收到（事件, eventId）；eventId 为空串表示持久化降级（Redis 故障） */
export type Subscriber = (event: AguiEvent, eventId: string) => void;

export interface RunManagerConfig {
    maxConcurrentRuns: number;
    runTimeoutMs: number;
}

export interface RunManagerDeps {
    config: RunManagerConfig;
    persistence: Persistence;
}

export type RegisterResult =
    | { ok: true }
    | { ok: false; code: 'run_already_active'; activeRunId: string }
    | { ok: false; code: 'too_many_concurrent' };

export interface RunSnapshot {
    runId: string;
    threadId: string;
    status: RunStatus;
    startedAt: number;
    endedAt?: number;
    error?: string;
}

interface ActiveRun {
    runId: string;
    threadId: string;
    controller: AbortController;
    subscribers: Set<Subscriber>;
    status: RunStatus;
    startedAt: number;
    endedAt?: number;
    error?: string;
    /** cancel/timeout 的归因（abort 后 catch 分支读取） */
    cancelReason?: 'cancelled' | 'timeout';
}

export class RunManager {
    private readonly active = new Map<string, ActiveRun>();
    /** thread 级订阅（GET /events 回放尾随用；run 级订阅给 POST /agui 的响应流） */
    private readonly threadSubscribers = new Map<string, Set<Subscriber>>();
    /** 终态快照（有界），支撑幂等 cancel / 状态查询 */
    private readonly finished = new Map<string, RunSnapshot>();
    private static readonly FINISHED_HISTORY_LIMIT = 256;

    constructor(private readonly deps: RunManagerDeps) {}

    /** 占位登记（先登记后订阅再启动，保证订阅不漏首事件） */
    register(threadId: string, runId: string): RegisterResult {
        for (const run of this.active.values()) {
            if (run.threadId === threadId && run.status === 'running') {
                return { ok: false, code: 'run_already_active', activeRunId: run.runId };
            }
        }
        if (this.active.size >= this.deps.config.maxConcurrentRuns) {
            return { ok: false, code: 'too_many_concurrent' };
        }
        this.active.set(runId, {
            runId,
            threadId,
            controller: new AbortController(),
            subscribers: new Set(),
            status: 'running',
            startedAt: Date.now(),
        });
        void this.deps.persistence.createRun(runId, threadId).catch((error) => {
            console.warn(`[run] createRun persist failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return { ok: true };
    }

    subscribe(runId: string, subscriber: Subscriber): (() => void) | undefined {
        const run = this.active.get(runId);
        if (!run) return undefined;
        run.subscribers.add(subscriber);
        return () => run.subscribers.delete(subscriber);
    }

    /** thread 级订阅：覆盖该 thread 下全部 run（含未来启动的）；返回退订函数 */
    subscribeThread(threadId: string, subscriber: Subscriber): () => void {
        let set = this.threadSubscribers.get(threadId);
        if (!set) {
            set = new Set();
            this.threadSubscribers.set(threadId, set);
        }
        set.add(subscriber);
        return () => {
            set?.delete(subscriber);
            if (set && set.size === 0) this.threadSubscribers.delete(threadId);
        };
    }

    /** 启动执行（fire-and-forget；终态经事件流与 getRun 上报） */
    start(runId: string, query: string): void {
        const run = this.active.get(runId);
        if (!run || run.status !== 'running') return;
        void this.execute(run, query);
    }

    /** 显式取消（幂等：已终态返回终态） */
    cancel(runId: string): RunSnapshot | undefined {
        const run = this.active.get(runId);
        if (!run) return this.finished.get(runId);
        if (run.status === 'running') {
            run.cancelReason = 'cancelled';
            run.controller.abort();
        }
        return this.snapshot(run);
    }

    getRun(runId: string): RunSnapshot | undefined {
        const run = this.active.get(runId);
        return run ? this.snapshot(run) : this.finished.get(runId);
    }

    /** thread 的活跃 run（threads REST 的 activeRun 字段） */
    getActiveRunByThread(threadId: string): { runId: string; status: 'running' } | null {
        for (const run of this.active.values()) {
            if (run.threadId === threadId && run.status === 'running') {
                return { runId: run.runId, status: 'running' };
            }
        }
        return null;
    }

    /** 优雅停机用：等待活跃 run 收尾，至多 timeoutMs；返回是否全部结束 */
    async waitIdle(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (this.active.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return this.active.size === 0;
    }

    private snapshot(run: ActiveRun): RunSnapshot {
        return {
            runId: run.runId,
            threadId: run.threadId,
            status: run.status,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            error: run.error,
        };
    }

    private fanout(run: ActiveRun, event: AguiEvent, eventId: string): void {
        const deliver = (subscriber: Subscriber) => {
            try {
                subscriber(event, eventId);
            } catch (error) {
                console.warn(`[run] subscriber error: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        for (const subscriber of run.subscribers) deliver(subscriber);
        const threadSet = this.threadSubscribers.get(run.threadId);
        if (threadSet) for (const subscriber of threadSet) deliver(subscriber);
    }

    private async execute(run: ActiveRun, query: string): Promise<void> {
        // CozeLoop 根 span（自定义类型 'run'）：baggages 把 thread_id/run_id 透传到
        // 全部子 span（LLM/工具/检索阶段，方案 cozeloop-observability-plan.md §3.3）。
        // 禁用时直通原逻辑。
        await withCozeLoopSpan(
            'rag-agent',
            'run',
            async (span) => {
                setSpanInput(span, { query, threadId: run.threadId, runId: run.runId });
                await this.executeRun(run, query, span);
            },
            {
                baggages: { thread_id: run.threadId, run_id: run.runId },
            },
        );
    }

    /**
     * XADD 先行：拿到 eventId 再扇出，SSE id: 帧与回放游标一致；
     * 持久化失败降级为内存直发（eventId=''，断线回放将缺失该事件——故障态可接受）
     */
    private async persistAndFanout(run: ActiveRun, event: AguiEvent): Promise<void> {
        let eventId = '';
        try {
            eventId = await this.deps.persistence.appendEvent(run.threadId, event);
        } catch (error) {
            console.warn(`[run] appendEvent failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.fanout(run, event, eventId);
    }

    private async executeRun(run: ActiveRun, query: string, span: Span | null): Promise<void> {
        // CozeLoop 根 span 的 traceId：随 CUSTOM cozeloop.trace 事件透出给前端，
        // 用户可复制到罗盘后台按 trace 检索；禁用时 span 为 null，不发射
        const cozeloopTraceId = span?.spanContext().traceId;
        let traceEventSent = false;
        const timeout = setTimeout(() => {
            run.cancelReason = 'timeout';
            run.controller.abort();
        }, this.deps.config.runTimeoutMs);
        let lastSnapshotCount: number | undefined;

        try {
            const agent = getAgent();
            const stream = await agent.streamEvents(
                { messages: [new HumanMessage(query)] },
                {
                    version: 'v3',
                    signal: run.controller.signal,
                    // thread_id 让 checkpointer 按 thread 恢复多轮上下文（方案 §7.3）
                    configurable: { thread_id: run.threadId },
                    // CozeLoop：config 级回调兜底（与 LLM 实例级回调同一 handler，run_id 幂等去重）
                    callbacks: getLangChainTracingCallbacks(),
                },
            );
            for await (const event of translateRun(stream as unknown as TranslatableRunStream, {
                threadId: run.threadId,
                runId: run.runId,
            })) {
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                    lastSnapshotCount = (event as unknown as { messages: unknown[] }).messages.length;
                }
                await this.persistAndFanout(run, event);
                // 紧跟 RUN_STARTED 发 traceId：必须在该事件之后，前端归约按当前 turn 落位
                if (!traceEventSent && cozeloopTraceId && event.type === EventType.RUN_STARTED) {
                    traceEventSent = true;
                    console.log(`🔭 [run] cozeloop trace ${cozeloopTraceId} (thread=${run.threadId} run=${run.runId})`);
                    await this.persistAndFanout(run, {
                        type: EventType.CUSTOM,
                        name: 'cozeloop.trace',
                        value: { traceId: cozeloopTraceId, runId: run.runId },
                        timestamp: Date.now(),
                    } as AguiEvent);
                }
            }
            run.status = 'finished';
        } catch (error) {
            run.status = run.cancelReason === 'timeout' ? 'timeout' : run.cancelReason === 'cancelled' ? 'cancelled' : 'error';
            run.error = error instanceof Error ? error.message : String(error);
            const code = run.status === 'error' ? 'server_error' : run.status;
            const terminalEvent: AguiEvent = {
                type: EventType.RUN_ERROR,
                message: run.error,
                code,
                timestamp: Date.now(),
            };
            await this.persistAndFanout(run, terminalEvent);
        } finally {
            clearTimeout(timeout);
            run.endedAt = Date.now();
            this.active.delete(run.runId);
            this.finished.set(run.runId, this.snapshot(run));
            if (this.finished.size > RunManager.FINISHED_HISTORY_LIMIT) {
                const oldest = this.finished.keys().next().value;
                if (oldest !== undefined) this.finished.delete(oldest);
            }
            void this.deps.persistence
                .finishRun(run.runId, run.status, run.error)
                .catch(() => undefined);
            if (lastSnapshotCount !== undefined) {
                void this.deps.persistence
                    .updateMessageCount(run.threadId, lastSnapshotCount)
                    .catch(() => undefined);
            }
        }

        // 根 span 收口：终态与错误信息（traceable 在 fn 返回时自动 end span）
        setSpanOutput(span, { status: run.status, error: run.error });
    }
}
