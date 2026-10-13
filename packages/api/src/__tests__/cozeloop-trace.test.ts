// ============================================================================
// cozeloop.trace CUSTOM 事件（runManager → SSE/回放）：启用 CozeLoop 后，
// RUN_STARTED 之后应紧跟 CUSTOM{name:'cozeloop.trace'}，携带根 span 的 traceId。
// @cozeloop/ai 全 mock（不触网络、span 固定 traceId）；agent/redis mock 同
// agui-route.test 的假流方案。
// ============================================================================

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FAKE_TRACE_ID = 'aabbccdd11223344aabbccdd11223344';

// 在 @langchain-rag/rag 出口处 mock observability 接缝（runManager 实际消费的面）。
// 不能 vi.mock('@cozeloop/ai')：api 包不直接依赖它，mock 按测试文件上下文解析，
// 拦不住 rag 包内部的 SDK 导入（实测会加载真实 OTel，traceId 变成随机值）。
vi.mock('@langchain-rag/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@langchain-rag/rag')>();
    const fakeSpan = {
        spanContext: () => ({ traceId: FAKE_TRACE_ID, spanId: 'span0001', traceFlags: 1 }),
        setAttribute: () => {},
        end: () => {},
    };
    return {
        ...actual,
        initCozeLoop: () => true,
        shutdownCozeLoop: () => {},
        withCozeLoopSpan: (_name: string, _type: string, fn: (span: unknown) => unknown) =>
            fn(fakeSpan) as unknown,
        getLangChainTracingCallbacks: () => [],
        setSpanInput: () => {},
        setSpanOutput: () => {},
    };
});

function makeFakeStream() {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    return {
        async *[Symbol.asyncIterator]() {
            const chunks = [
                { seq: 0, method: 'messages', params: { namespace: ['model_request:A'], data: { event: 'message-start', id: 'm1' } } },
                { seq: 1, method: 'messages', params: { namespace: ['model_request:A'], data: { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: '答' } } } },
                { seq: 2, method: 'messages', params: { namespace: ['model_request:A'], data: { event: 'message-finish' } } },
            ];
            for (const chunk of chunks) {
                await sleep(10);
                yield chunk;
            }
        },
        output: sleep(10).then(() => ({
            messages: [
                { id: 'u0', getType: () => 'human', content: 'q' },
                { id: 'm1', getType: () => 'ai', content: '答案' },
            ],
        })),
    };
}

vi.mock('../agentService.js', () => ({
    getAgentState: () => ({ status: 'ready' }),
    getAgent: () => ({
        streamEvents: () => Promise.resolve(makeFakeStream()),
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
import { createMemoryPersistence } from '../persistence/memory.js';

let server: Server | undefined;
let baseUrl: string | undefined;

afterEach(async () => {
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
    server = created.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { address, port } = server.address() as AddressInfo;
    baseUrl = `http://${address}:${port}`;
    return baseUrl;
}

/** 读取 SSE 直至 RUN_FINISHED，返回 data: 帧解析出的对象数组 */
async function readSSE(res: Response): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
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
                        if (parsed.type === 'RUN_FINISHED') return events;
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    return events;
}

describe('cozeloop.trace CUSTOM 事件', () => {
    it('RUN_STARTED 之后紧跟 CUSTOM(cozeloop.trace)，携带根 span traceId；回放同样可见', async () => {
        const url = await listen();
        const res = await fetch(`${url}/agui`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId: 't-cozeloop',
                runId: 'r-cozeloop',
                messages: [{ id: 'u0', role: 'user', content: '测试' }],
            }),
        });
        expect(res.status).toBe(200);
        const events = await readSSE(res);

        const startedAt = events.findIndex((e) => e.type === 'RUN_STARTED');
        const traceAt = events.findIndex(
            (e) => e.type === 'CUSTOM' && e.name === 'cozeloop.trace',
        );
        expect(startedAt).toBeGreaterThanOrEqual(0);
        expect(traceAt).toBeGreaterThan(startedAt);
        expect(events[traceAt]!.value).toMatchObject({ traceId: FAKE_TRACE_ID, runId: 'r-cozeloop' });

        // 断线回放：事件日志里的顺序保持 RUN_STARTED → CUSTOM
        const replayRes = await fetch(`${url}/threads/t-cozeloop/events?afterEventId=0`);
        expect(replayRes.status).toBe(200);
        const replayText = await replayRes.text();
        const startedIdx = replayText.indexOf('"type":"RUN_STARTED"');
        const traceIdx = replayText.indexOf('"name":"cozeloop.trace"');
        expect(traceIdx).toBeGreaterThan(startedIdx);
        expect(replayText).toContain(FAKE_TRACE_ID);
    });
});
