// ============================================================================
// ThreadController：每打开线程一个，编排两条 SSE 通道（frontend-plan.md §6）
//
//   写通道 POST /agui（send：乐观 Turn → 读流，异常早断转读通道续传）
//   读通道 GET /threads/:id/events?afterEventId=（open：全量回放；resume：断线重连）
//
// 纪律：断开 ≠ 取消——停止生成必须显式调 cancel 端点（api-service-plan.md D6）。
// ============================================================================

import type { AguiEvent } from '../types';
import type { ChatStore, IncomingEvent } from './chatStore';
import { ApiError, type ThreadsApi } from './api';
import { parseAguiEvent, readSseStream, type SseMessage } from './sse';

const BATCH_FLUSH_SIZE = 32;

export type SendFailure = { code?: string; message: string };

export interface ThreadControllerOptions {
    baseUrl: string;
    threadId: string | null;
    store: ChatStore;
    api: ThreadsApi;
    /** 注入以便单测；默认全局 fetch */
    fetchImpl?: typeof fetch;
    /** 重连退避基数（ms），默认 1000，指数退避上限 15s；单测注入 1 */
    retryBaseMs?: number;
    /** 首次发送时线程自建回调（用于路由跳转） */
    onThreadCreated?: (threadId: string) => void;
}

export function mapSendError(error: ApiError): SendFailure {
    switch (error.code) {
        case 'too_many_concurrent':
            return { code: error.code, message: `服务繁忙（并发已满），请约 ${error.retryAfterSeconds ?? 5} 秒后重试` };
        case 'agent_not_ready':
            return { code: error.code, message: '服务尚未就绪（agent 预热中），请稍后重试' };
        case 'persistence_unavailable':
            return { code: error.code, message: '持久化服务不可用，请稍后重试' };
        case 'network_error':
            return { code: error.code, message: '网络错误，无法连接服务' };
        default:
            return { code: error.code, message: `请求失败：${error.message}` };
    }
}

export class ThreadController {
    threadId: string | null;
    /** open() 是否已生效（send 自建线程时置位，防止路由跳变触发重复 open reset） */
    private opened = false;
    private readonly baseUrl: string;
    private readonly store: ChatStore;
    private readonly api: ThreadsApi;
    private readonly fetchImpl: typeof fetch;
    private readonly retryBaseMs: number;
    private readonly onThreadCreated?: (threadId: string) => void;

    /** open()/dispose() 递增使旧通道循环失效退出 */
    private epoch = 0;
    private channelAbort: AbortController | null = null;
    /** 正在消费的流数（写+读）；>0 时 visibility/online 不触发重同步 */
    private liveChannels = 0;

    constructor(options: ThreadControllerOptions) {
        this.threadId = options.threadId;
        this.baseUrl = options.baseUrl;
        this.store = options.store;
        this.api = options.api;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.retryBaseMs = options.retryBaseMs ?? 1000;
        this.onThreadCreated = options.onThreadCreated;
        // node 测试环境无 document/window；仅浏览器注册
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
        if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    }

    /** 打开线程：null = 新会话；已有线程 → 全量回放 + 活跃 run 尾随 */
    async open(threadId: string | null): Promise<void> {
        if (this.opened && this.threadId === threadId) return;
        this.closeChannels();
        this.threadId = threadId;
        this.opened = true;

        if (threadId === null) {
            this.store.dispatch({ type: 'reset', phase: 'empty' });
            return;
        }
        this.store.dispatch({ type: 'reset', phase: 'loading' });
        try {
            await this.api.get(threadId);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                // 尚无任何 run 的新会话（客户端生成 id、未发送）
                this.store.dispatch({ type: 'reset', phase: 'empty' });
                return;
            }
            this.store.dispatch({ type: 'loadFailed', error: toSendFailure(error) });
            return;
        }
        await this.attachLoop('0', 'open');
    }

    /** 发送一条消息（本轮输入只传最后一条 user 消息，历史以服务端为准） */
    async send(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed || this.store.getState().activeRunId !== null) return;
        if (this.threadId === null) {
            this.threadId = crypto.randomUUID();
            this.opened = true;
            this.onThreadCreated?.(this.threadId);
        }
        const threadId = this.threadId;

        const runId = crypto.randomUUID();
        this.store.dispatch({ type: 'optimisticSend', runId, text: trimmed });

        try {
            const res = await this.fetchImpl(`${this.baseUrl}/agui`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // 断开 ≠ 取消：abort 只结束本流消费，服务端 run 继续执行（D6）
                signal: this.channelSignal(),
                body: JSON.stringify({
                    threadId,
                    runId,
                    messages: [{ id: crypto.randomUUID(), role: 'user', content: trimmed }],
                }),
            });
            if (!res.ok || !res.body) {
                const error = await this.responseError(res);
                if (error.code === 'run_already_active') {
                    // 同线程已有活跃 run（其他窗口/端）：本端乐观 Turn 置错并转 attach 跟随
                    this.store.dispatch({
                        type: 'sendFailed',
                        runId,
                        error: { code: error.code, message: '该会话已在其他窗口运行中，已切换为跟随模式' },
                    });
                    await this.attachLoop(this.cursor(), 'follow');
                    return;
                }
                this.store.dispatch({ type: 'sendFailed', runId, error: mapSendError(error) });
                return;
            }
            await this.pumpStream(res.body);
            if (this.store.getState().activeRunId !== null) {
                // 流早断（未见终态）→ 读通道续传
                await this.attachLoop(this.cursor(), 'resume');
            } else {
                this.store.dispatch({ type: 'channel', channel: { state: 'ok' } });
            }
        } catch {
            // run 是否已在服务端启动未知：attachLoop 内对照服务端元数据裁决
            await this.attachLoop(this.cursor(), 'resume').catch(() => undefined);
        }
    }

    /** 停止当前 run（显式 cancel；断开连接不会取消） */
    async stop(): Promise<void> {
        const runId = this.store.getState().activeRunId;
        if (runId === null || this.threadId === null) return;
        try {
            await this.api.cancelRun(this.threadId, runId);
        } catch {
            // run 可能刚结束或服务暂不可达：流内终态事件或重同步兜底
        }
    }

    dispose(): void {
        this.closeChannels();
        this.epoch += 1;
        this.opened = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
        if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    private cursor(): string {
        return this.store.getState().lastEventId || '0';
    }

    private closeChannels(): void {
        this.epoch += 1;
        this.channelAbort?.abort();
        this.channelAbort = null;
    }

    private async responseError(res: Response): Promise<ApiError> {
        let body: { error: { code: string; message: string }; runId?: string } | null = null;
        try {
            body = (await res.json()) as { error: { code: string; message: string }; runId?: string };
        } catch {
            body = null;
        }
        const retryAfter = res.headers.get('Retry-After');
        return new ApiError(res.status, body, retryAfter ? Number(retryAfter) : undefined);
    }

    /**
     * 读通道：回放 + 尾随；断流指数退避重连，直至终态 / 无活跃 run / epoch 失效。
     * purpose：open=打开线程全量回放；resume=断线续传（本端有 activeRunId）；
     * follow=409 跟随其他端发起的活跃 run（本端 activeRunId 为空也要附流）。
     *
     * 顺序约束：先回放再裁决——服务重启后进程会补发 RUN_ERROR{server_restart}
     * 并清理 activeRun，若先查 meta 会错过该事件只剩「状态未知」。
     */
    private async attachLoop(afterEventId: string, purpose: 'open' | 'resume' | 'follow'): Promise<void> {
        const epoch = this.epoch;
        let attempt = 0;
        let cursor = afterEventId;
        while (this.epoch === epoch && this.threadId !== null) {
            if (purpose === 'resume' && this.store.getState().activeRunId === null) {
                // 另一并行循环可能已完成收口：清除本循环遗留的重连横幅
                if (this.store.getState().channel.state === 'reconnecting') {
                    this.store.dispatch({ type: 'channel', channel: { state: 'ok' } });
                }
                return;
            }
            try {
                if (attempt > 0) this.store.dispatch({ type: 'channel', channel: { state: 'ok' } });
                cursor = await this.consumeEventsStream(cursor, epoch);
                if (this.epoch !== epoch) return;
                if (this.store.getState().activeRunId === null) {
                    this.store.dispatch({ type: 'channel', channel: { state: 'ok' } });
                    return;
                }
                // 流正常结束但未见终态：服务端已无活跃 run（重启清理/从未启动）或瞬时空窗
                const meta = await this.api.get(this.threadId);
                if (!meta.activeRun) {
                    this.store.dispatch({ type: 'resolveStaleRun' });
                    return;
                }
                cursor = this.cursor() || cursor;
            } catch {
                if (this.epoch !== epoch) return;
                cursor = this.cursor() || cursor;
            }
            attempt += 1;
            this.store.dispatch({ type: 'channel', channel: { state: 'reconnecting', attempt } });
            const delay = Math.min(15_000, this.retryBaseMs * 2 ** (attempt - 1));
            if (!(await this.sleep(delay, epoch))) return;
        }
    }

    private async consumeEventsStream(afterEventId: string, epoch: number): Promise<string> {
        if (this.epoch !== epoch || this.threadId === null) throw new Error('stale channel');
        const url = `${this.baseUrl}/threads/${this.threadId}/events?afterEventId=${encodeURIComponent(afterEventId)}`;
        const res = await this.fetchImpl(url, {
            signal: this.channelSignal(),
            headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw await this.responseError(res);
        return this.pumpStream(res.body, epoch);
    }

    /** 消费一条 SSE 流：解析 → 批量 dispatch；返回本流最后游标 */
    private async pumpStream(body: ReadableStream<Uint8Array>, epoch = this.epoch): Promise<string> {
        let cursor = '';
        let batch: IncomingEvent[] = [];
        this.liveChannels += 1;
        const stale = () => this.epoch !== epoch;
        try {
            await readSseStream(body, {
                signal: stale() ? AbortSignal.abort() : this.channelSignal(),
                onMessage: (message: SseMessage) => {
                    if (stale()) return;
                    if (message.eventId) cursor = message.eventId;
                    const event: AguiEvent | undefined = parseAguiEvent(message.data);
                    if (!event) return;
                    batch.push({ eventId: message.eventId, event });
                    if (batch.length >= BATCH_FLUSH_SIZE) {
                        this.store.dispatch({ type: 'events', batch });
                        batch = [];
                    }
                },
            });
        } finally {
            if (!stale() && batch.length > 0) this.store.dispatch({ type: 'events', batch });
            this.liveChannels -= 1;
        }
        return cursor;
    }

    private channelSignal(): AbortSignal {
        if (this.channelAbort === null) this.channelAbort = new AbortController();
        return this.channelAbort.signal;
    }

    /** 可中断 sleep；返回 false 表示 epoch 已失效或通道被关闭 */
    private sleep(ms: number, epoch: number): Promise<boolean> {
        if (this.epoch !== epoch) return Promise.resolve(false);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve(this.epoch === epoch);
            }, ms);
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const signal = this.channelAbort?.signal;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            if (signal) {
                if (signal.aborted) {
                    cleanup();
                    resolve(false);
                    return;
                }
                signal.addEventListener('abort', onAbort);
            }
        });
    }

    /** 页面休眠期间流可能已被杀：回到前台/网络恢复时若仍有活跃 run 则续传 */
    private readonly onVisibility = (): void => {
        if (document.visibilityState === 'visible') this.resync();
    };

    private readonly onOnline = (): void => {
        this.resync();
    };

    private resync(): void {
        if (this.threadId === null || this.liveChannels > 0) return;
        if (this.store.getState().activeRunId === null) return;
        void this.attachLoop(this.cursor(), 'resume');
    }
}

function toSendFailure(error: unknown): SendFailure {
    if (error instanceof ApiError) return mapSendError(error);
    return { code: 'network_error', message: '网络错误，无法连接服务' };
}
