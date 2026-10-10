// ============================================================================
// RunManager（P1：内存扇出版；方案 §8）
//
// - run 与 SSE 连接解耦：订阅者断开只是退订，run 继续执行至终态（§8.3/D6）
// - 每 thread 同时至多 1 个活跃 run（§5.1 约束，409）
// - 进程级并发闸门 RAG_MAX_CONCURRENT_RUNS（§8.4，429）
// - 超时 RAG_RUN_TIMEOUT_MS 强制 abort → RUN_ERROR{code:"timeout"}
// - 取消：AbortController，语义为 RUN_ERROR{code:"cancelled"}（P1 无协议级取消事件）
// - P2 接入 Redis Stream 持久化与断线回放时，emit() 处加 XADD 即可
// ============================================================================

import { HumanMessage } from '@langchain/core/messages';
import { EventType, type Event as AguiEvent } from '@ag-ui/core';
import { getAgent } from './agentService.js';
import { translateRun, type TranslatableRunStream } from './agui/translator.js';

export type RunStatus = 'running' | 'finished' | 'error' | 'cancelled' | 'timeout';

export type Subscriber = (event: AguiEvent) => void;

export interface RunManagerConfig {
    maxConcurrentRuns: number;
    runTimeoutMs: number;
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
    /** 终态快照（有界），支撑幂等 cancel / 状态查询；P2 起由 Redis 接管 */
    private readonly finished = new Map<string, RunSnapshot>();
    private static readonly FINISHED_HISTORY_LIMIT = 256;

    constructor(private readonly config: RunManagerConfig) {}

    /** 占位登记（先登记后订阅再启动，保证订阅不漏首事件） */
    register(threadId: string, runId: string): RegisterResult {
        for (const run of this.active.values()) {
            if (run.threadId === threadId && run.status === 'running') {
                return { ok: false, code: 'run_already_active', activeRunId: run.runId };
            }
        }
        if (this.active.size >= this.config.maxConcurrentRuns) {
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
        return { ok: true };
    }

    subscribe(runId: string, subscriber: Subscriber): (() => void) | undefined {
        const run = this.active.get(runId);
        if (!run) return undefined;
        run.subscribers.add(subscriber);
        return () => run.subscribers.delete(subscriber);
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

    private emit(run: ActiveRun, event: AguiEvent): void {
        for (const subscriber of run.subscribers) {
            try {
                subscriber(event);
            } catch (error) {
                // 单个订阅者故障不影响 run 与其他订阅者
                console.warn(`[run] subscriber error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async execute(run: ActiveRun, query: string): Promise<void> {
        const timeout = setTimeout(() => {
            run.cancelReason = 'timeout';
            run.controller.abort();
        }, this.config.runTimeoutMs);

        try {
            const agent = getAgent();
            const stream = await agent.streamEvents(
                { messages: [new HumanMessage(query)] },
                { version: 'v3', signal: run.controller.signal },
            );
            for await (const event of translateRun(stream as unknown as TranslatableRunStream, {
                threadId: run.threadId,
                runId: run.runId,
            })) {
                this.emit(run, event);
            }
            run.status = 'finished';
        } catch (error) {
            // streamEvents/translate 抛出（含 abort）：统一转 RUN_ERROR 终态事件
            run.status = run.cancelReason === 'timeout' ? 'timeout' : run.cancelReason === 'cancelled' ? 'cancelled' : 'error';
            run.error = error instanceof Error ? error.message : String(error);
            const code = run.status === 'error' ? 'server_error' : run.status;
            this.emit(run, {
                type: EventType.RUN_ERROR,
                message: run.error,
                code,
                timestamp: Date.now(),
            });
        } finally {
            clearTimeout(timeout);
            run.endedAt = Date.now();
            this.active.delete(run.runId);
            this.finished.set(run.runId, this.snapshot(run));
            if (this.finished.size > RunManager.FINISHED_HISTORY_LIMIT) {
                const oldest = this.finished.keys().next().value;
                if (oldest !== undefined) this.finished.delete(oldest);
            }
        }
    }
}
