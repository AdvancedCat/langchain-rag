import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// agent 与 redis 全部 mock：SSE 路由测试不触碰真实 Qdrant/LLM/Redis，
// 真实链路由冒烟（pnpm serve + curl /agui）覆盖。

const agentStatus = vi.hoisted(() => ({ value: 'ready' as string }));

/** 伪造的 agent 流：总时长 ~300ms（12 × 25ms），保证并发/取消测试赶得上；尊重 abort signal */
function makeFakeStream(signal?: AbortSignal) {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    return {
        async *[Symbol.asyncIterator]() {
            const chunks = [
                { seq: 0, method: 'messages', params: { namespace: ['model_request:A'], data: { event: 'message-start', id: 'm1' } } },
                ...Array.from({ length: 10 }, (_, i) => ({
                    seq: i + 1,
                    method: 'messages',
                    params: { namespace: ['model_request:A'], data: { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: '字' } } },
                })),
                { seq: 11, method: 'messages', params: { namespace: ['model_request:A'], data: { event: 'message-finish' } } },
            ];
            for (const chunk of chunks) {
                if (signal?.aborted) throw new Error('Aborted');
                await sleep(25);
                yield chunk;
            }
        },
        output: sleep(25).then(() => ({
            messages: [
                { id: 'u0', getType: () => 'human', content: 'q' },
                { id: 'm1', getType: () => 'ai', content: '你好，世界' },
            ],
        })),
    };
}

vi.mock('../agentService.js', () => ({
    getAgentState: () => ({ status: agentStatus.value }),
    getAgent: () => ({
        streamEvents: (_input: unknown, config?: { signal?: AbortSignal }) =>
            Promise.resolve(makeFakeStream(config?.signal)),
    }),
    warmupAgent: vi.fn(),
    getCheckpointer: vi.fn(async () => ({ deleteThread: vi.fn() })),
}));

vi.mock('../redis.js', () => ({
    pingRedis: () => Promise.resolve(false),
    getRedis: vi.fn(),
    closeRedis: vi.fn(async () => {}),
}));

import { createApp } from '../app.js';
import type { RunManager } from '../runManager.js';
import { createMemoryPersistence } from '../persistence/memory.js';

let server: Server | undefined;
let runManager: RunManager | undefined;
let baseUrl: string | undefined;

afterEach(async () => {
    agentStatus.value = 'ready';
    if (server) {
        // undici 的 keep-alive 空闲连接会拖住 close 回调，先回收再等
        server.closeIdleConnections();
        server.close();
        await once(server, 'close');
        server = undefined;
    }
    baseUrl = undefined;
});

async function listen(): Promise<string> {
    const created = createApp({ persistence: createMemoryPersistence() });
    runManager = created.runManager;
    server = created.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { address, port } = server.address() as AddressInfo;
    baseUrl = `http://${address}:${port}`;
    return baseUrl;
}

function runInput(threadId: string, runId: string, query = '测试问题') {
    return {
        threadId,
        runId,
        messages: [
            { id: 'u0', role: 'user', content: query },
        ],
    };
}

/** 读取 SSE 流直至终端事件（RUN_FINISHED/RUN_ERROR），返回解析出的事件列表 */
async function readSSE(res: Response, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                for (const line of frame.split('\n')) {
                    if (line.startsWith('data: ')) {
                        const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
                        events.push(parsed);
                        if (parsed.type === 'RUN_FINISHED' || parsed.type === 'RUN_ERROR') {
                            return events;
                        }
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    return events;
}

async function waitRunTerminal(runId: string): Promise<string | undefined> {
    for (let i = 0; i < 200; i++) {
        const snapshot = runManager?.getRun(runId);
        if (snapshot && snapshot.status !== 'running') return snapshot.status;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return undefined;
}

describe('POST /agui', () => {
    it('完整 SSE 事件序列：RUN_STARTED → 文本流 → MESSAGES_SNAPSHOT → RUN_FINISHED', async () => {
        const base = await listen();
        const res = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t1', 'r1')),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const events = await readSSE(res);
        expect(events.map((e) => e.type)).toEqual([
            'RUN_STARTED',
            'TEXT_MESSAGE_START',
            ...Array.from({ length: 10 }, () => 'TEXT_MESSAGE_CONTENT'),
            'TEXT_MESSAGE_END',
            'MESSAGES_SNAPSHOT',
            'RUN_FINISHED',
        ]);
        const start = events[0];
        expect(start).toMatchObject({ threadId: 't1', runId: 'r1' });
        const snapshot = events.at(-2) as { messages: unknown[] };
        expect(snapshot.messages).toHaveLength(2);
    });

    it('agent 未就绪 → 503；缺 user 消息 → 400；非法 body → 400', async () => {
        const base = await listen();

        agentStatus.value = 'building';
        const notReady = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t', 'r')),
        });
        expect(notReady.status).toBe(503);
        expect(await notReady.json()).toMatchObject({ error: { code: 'agent_not_ready' } });
        agentStatus.value = 'ready';

        const noUser = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: 't', runId: 'r2', messages: [] }),
        });
        expect(noUser.status).toBe(400);
        expect(await noUser.json()).toMatchObject({ error: { code: 'no_user_message' } });

        const bad = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: 1 }),
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: { code: 'invalid_input' } });
    });

    it('同 thread 并发 → 409 run_already_active；并发闸门 → 429', async () => {
        const base = await listen();

        const first = fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t1', 'r1')),
        }).then((r) => readSSE(r));
        await new Promise((resolve) => setTimeout(resolve, 50)); // 等 r1 进入 running

        const conflict = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t1', 'r2')),
        });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ error: { code: 'run_already_active' } });

        // 默认闸门 4：t2/t3/t4 占满后 t5 → 429
        const others = ['r3', 'r4', 'r5'].map((runId) =>
            fetch(`${base}/agui`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(runInput(`t-${runId}`, runId)),
            }).then((r) => readSSE(r)),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        const rejected = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t9', 'r9')),
        });
        expect(rejected.status).toBe(429);
        expect(rejected.headers.get('retry-after')).toBe('5');

        await Promise.all([first, ...others]);
    });

    it('断开 SSE ≠ 取消：客户端断开后 run 跑完并进入 finished', async () => {
        const base = await listen();
        const controller = new AbortController();

        const res = await fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t1', 'r-disconnect')),
            signal: controller.signal,
        });
        // 读到首个事件后断开
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        controller.abort();
        try {
            reader.releaseLock();
        } catch {
            // abort 后锁可能已释放
        }

        // run 不受连接断开影响，最终 finished
        expect(await waitRunTerminal('r-disconnect')).toBe('finished');
    });

    it('cancel 端点：RUN_ERROR{code:"cancelled"} 收流，状态幂等', async () => {
        const base = await listen();

        const streamPromise = fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runInput('t1', 'r-cancel')),
        }).then((r) => readSSE(r));

        await new Promise((resolve) => setTimeout(resolve, 50));
        const cancelRes = await fetch(`${base}/threads/t1/runs/r-cancel/cancel`, { method: 'POST' });
        expect(cancelRes.status).toBe(200);
        expect(await cancelRes.json()).toMatchObject({ runId: 'r-cancel', status: 'cancelling' });

        const events = await streamPromise;
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({ type: 'RUN_ERROR', code: 'cancelled' });

        // 幂等：终态后再次 cancel 返回终态
        const again = await fetch(`${base}/threads/t1/runs/r-cancel/cancel`, { method: 'POST' });
        expect(await again.json()).toMatchObject({ runId: 'r-cancel', status: 'cancelled' });
    });

    it('未知 runId 的 cancel → 404', async () => {
        const base = await listen();
        const res = await fetch(`${base}/threads/t1/runs/nope/cancel`, { method: 'POST' });
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ error: { code: 'run_not_found' } });
    });
});
