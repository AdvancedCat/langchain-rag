import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// threads REST + 断线续传端点：内存持久化注入 + mock agent，真实 Redis 链路
// 由集成测试（redis-persistence.int.test.ts）与冒烟覆盖。

const agentStatus = vi.hoisted(() => ({ value: 'ready' as string }));

/** 伪造的 agent 流：12 chunk × 25ms ≈ 300ms，尊重 abort signal */
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
import type { Persistence } from '../persistence/types.js';
import { createMemoryPersistence } from '../persistence/memory.js';

let server: Server | undefined;
let runManager: RunManager | undefined;
let persistence: Persistence | undefined;
let baseUrl: string | undefined;

afterEach(async () => {
    agentStatus.value = 'ready';
    if (server) {
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
    persistence = created.persistence;
    server = created.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { address, port } = server.address() as AddressInfo;
    baseUrl = `http://${address}:${port}`;
    return baseUrl;
}

/** 读 SSE 至关流（无活跃 run 的回放场景）或终端事件；返回事件与游标 */
async function readSSEFully(res: Response): Promise<{ events: Array<Record<string, unknown>>; ids: string[] }> {
    const events: Array<Record<string, unknown>> = [];
    const ids: string[] = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let frameId: string | undefined;
            for (const line of frame.split('\n')) {
                if (line.startsWith('id: ')) frameId = line.slice(4);
                if (line.startsWith('data: ')) {
                    events.push(JSON.parse(line.slice(6)));
                    if (frameId) ids.push(frameId);
                }
            }
        }
    }
    return { events, ids };
}

async function runQuery(base: string, threadId: string, query = '测试问题'): Promise<void> {
    const res = await fetch(`${base}/agui`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            threadId,
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: 'user', content: query }],
        }),
    });
    expect(res.status).toBe(200);
    await readSSEFully(res);
}

describe('threads REST', () => {
    it('POST /threads 显式建档；GET 详情；列表含 activeRun 与 messageCount', async () => {
        const base = await listen();

        const created = await fetch(`${base}/threads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '会话一' }),
        });
        expect(created.status).toBe(201);
        const meta = (await created.json()) as { threadId: string; title: string };
        expect(meta.title).toBe('会话一');

        await runQuery(base, meta.threadId, '第一条问题');

        const detailRes = await fetch(`${base}/threads/${meta.threadId}`);
        const detail = (await detailRes.json()) as { title: string; messageCount: number; lastEventId: string | null; activeRun: unknown };
        expect(detailRes.status).toBe(200);
        expect(detail.title).toBe('会话一');
        expect(detail.messageCount).toBe(2);
        expect(detail.lastEventId).toBeTruthy();
        expect(detail.activeRun).toBeNull();

        const listRes = await fetch(`${base}/threads`);
        const list = (await listRes.json()) as { items: Array<{ threadId: string; title: string | null; activeRun: unknown }> };
        expect(list.items.some((item) => item.threadId === meta.threadId && item.title === '会话一')).toBe(true);
    });

    it('POST /agui 自动建档并回填 title（首问摘要）', async () => {
        const base = await listen();
        const threadId = randomUUID();
        await runQuery(base, threadId, '这是一个很长的首问' + 'x'.repeat(80));

        const detail = (await (await fetch(`${base}/threads/${threadId}`)).json()) as { title: string | null };
        expect(detail.title).toBe(('这是一个很长的首问' + 'x'.repeat(80)).slice(0, 50));
    });

    it('GET /messages 返回最近 MESSAGES_SNAPSHOT；未知 thread 404', async () => {
        const base = await listen();
        const threadId = randomUUID();
        await runQuery(base, threadId);

        const messages = (await (await fetch(`${base}/threads/${threadId}/messages`)).json()) as {
            messages: Array<{ role: string; content: string }>;
        };
        expect(messages.messages).toHaveLength(2);
        expect(messages.messages[0]).toMatchObject({ role: 'user' });
        expect(messages.messages[1]).toMatchObject({ role: 'assistant', content: '你好，世界' });

        const notFound = await fetch(`${base}/threads/nope/messages`);
        expect(notFound.status).toBe(404);
    });

    it('DELETE /threads/:id 删除会话（事件+元数据+checkpoint）', async () => {
        const base = await listen();
        const threadId = randomUUID();
        await runQuery(base, threadId);

        expect((await fetch(`${base}/threads/${threadId}`, { method: 'DELETE' })).status).toBe(204);
        expect((await fetch(`${base}/threads/${threadId}`)).status).toBe(404);
        expect((await fetch(`${base}/threads/${threadId}/events`)).status).toBe(404);
        expect((await fetch(`${base}/threads/${threadId}`, { method: 'DELETE' })).status).toBe(404);
    });
});

describe('GET /threads/:id/events 断线续传', () => {
    it('run 结束后全量回放（afterEventId=0）并以终态关流', async () => {
        const base = await listen();
        const threadId = randomUUID();
        await runQuery(base, threadId);

        const res = await fetch(`${base}/threads/${threadId}/events?afterEventId=0`);
        expect(res.status).toBe(200);
        const { events, ids } = await readSSEFully(res);
        expect(events[0]).toMatchObject({ type: 'RUN_STARTED' });
        expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
        expect(events).toHaveLength(15); // RUN_STARTED + START + 10×CONTENT + END + SNAPSHOT + FINISHED
        // id 帧即游标，且严格递增唯一
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('run 进行中连接：回放前缀 + 实时尾随至终态，事件不丢不重', async () => {
        const base = await listen();
        const threadId = randomUUID();

        // 后台启动 run，不消费其 SSE（模拟前端刷新后只剩 attach 流）
        void fetch(`${base}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId,
                runId: 'r-live',
                messages: [{ id: 'u0', role: 'user', content: 'q' }],
            }),
        }).then((r) => readSSEFully(r));
        await new Promise((resolve) => setTimeout(resolve, 80)); // run 跑到中段

        const res = await fetch(`${base}/threads/${threadId}/events?afterEventId=0`);
        const { events, ids } = await readSSEFully(res);
        expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
        // 不丢：RUN_STARTED/START/END/SNAPSHOT/FINISHED 齐全；不重：id 唯一
        const types = events.map((e) => e.type);
        for (const required of ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_END', 'MESSAGES_SNAPSHOT', 'RUN_FINISHED']) {
            expect(types).toContain(required);
        }
        expect(new Set(ids).size).toBe(ids.length);
        expect(types.filter((t) => t === 'TEXT_MESSAGE_CONTENT')).toHaveLength(10);
    });

    it('游标续传：afterEventId 之后只补增量', async () => {
        const base = await listen();
        const threadId = randomUUID();
        await runQuery(base, threadId);

        // 全量回放取第 3 个事件游标
        const full = await fetch(`${base}/threads/${threadId}/events?afterEventId=0`);
        const { ids } = await readSSEFully(full);
        const cursor = ids[2];

        const partial = await fetch(`${base}/threads/${threadId}/events?afterEventId=${cursor}`);
        const { events } = await readSSEFully(partial);
        expect(events).toHaveLength(ids.length - 3);
        expect(events[0]).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT' });
        expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
    });

    it('无事件且无活跃 run：立即关流（空回放）', async () => {
        const base = await listen();
        const threadId = randomUUID();
        // 显式建档（未跑过 run 的会话）
        await persistence!.ensureThread(threadId);
        const res = await fetch(`${base}/threads/${threadId}/events`);
        expect(res.status).toBe(200);
        const { events } = await readSSEFully(res);
        expect(events).toHaveLength(0);
    });
});
