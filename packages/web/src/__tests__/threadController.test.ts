import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../lib/chatStore';
import { ApiError, createThreadsApi, type ThreadsApi } from '../lib/api';
import { ThreadController, type ThreadControllerOptions } from '../lib/threadController';
import { parseThreadId, threadHash } from '../router';

const encoder = new TextEncoder();

/** 造一条 SSE 帧（可选 id 行） */
function frame(event: object, eventId?: string): string {
    return `${eventId ? `id: ${eventId}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(frames: string[], init?: ResponseInit): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const text of frames) controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init });
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), { status, headers });
}

const META_IDLE = {
    threadId: 't1',
    title: null,
    createdAt: '',
    updatedAt: '',
    activeRun: null,
};
const META_RUNNING = { ...META_IDLE, activeRun: { runId: 'r-other', status: 'running' } };

interface Harness {
    store: ReturnType<typeof createChatStore>;
    controller: ThreadController;
    api: ThreadsApi;
    fetchMock: ReturnType<typeof vi.fn>;
    eventsUrls: () => string[];
}

function createHarness(apiOverrides?: Partial<ThreadsApi>): Harness {
    const fetchMock = vi.fn();
    const api: ThreadsApi = {
        ...createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch),
        list: vi.fn(),
        get: vi.fn(),
        remove: vi.fn(),
        cancelRun: vi.fn(),
        health: vi.fn(),
        ready: vi.fn(),
        ...apiOverrides,
    };
    const store = createChatStore();
    const options: ThreadControllerOptions = {
        baseUrl: 'http://api.test',
        threadId: null,
        store,
        api,
        fetchImpl: fetchMock as unknown as typeof fetch,
        retryBaseMs: 1,
    };
    const controller = new ThreadController(options);
    return {
        store,
        controller,
        api,
        fetchMock,
        eventsUrls: () => fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/events')),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ThreadController.open', () => {
    it('已有线程：全量回放（afterEventId=0）重建状态', async () => {
        const h = createHarness({ get: vi.fn().mockResolvedValue(META_IDLE) });
        h.fetchMock.mockResolvedValueOnce(
            sseResponse([
                frame({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1', timestamp: 0 }, '1-0'),
                frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant', timestamp: 0 }, '1-1'),
                frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '历史回答', timestamp: 0 }, '1-2'),
                frame({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: '历史问题' }], timestamp: 0 }, '1-3'),
                frame({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1', timestamp: 0 }, '1-4'),
            ]),
        );
        await h.controller.open('t1');
        expect(h.store.getState().phase).toBe('ready');
        expect(h.store.getState().turns).toHaveLength(1);
        expect(h.store.getState().turns[0]).toMatchObject({ userText: '历史问题', status: 'done' });
        expect(h.eventsUrls()[0]).toContain('afterEventId=0');
        expect(h.store.getState().channel).toEqual({ state: 'ok' });
        h.controller.dispose();
    });

    it('活跃 run：回放后尾随直至终态', async () => {
        const h = createHarness({ get: vi.fn().mockResolvedValue(META_RUNNING) });
        h.fetchMock.mockResolvedValueOnce(
            sseResponse([
                frame({ type: 'RUN_STARTED', threadId: 't1', runId: 'r-other', timestamp: 0 }, '1-0'),
                frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '进行中', timestamp: 0 }, '1-1'),
                frame({ type: 'RUN_ERROR', message: 'done', code: 'cancelled', timestamp: 0 }, '1-2'),
            ]),
        );
        await h.controller.open('t1');
        expect(h.store.getState().activeRunId).toBeNull();
        expect(h.store.getState().turns[0]!.status).toBe('cancelled');
        h.controller.dispose();
    });

    it('404：空会话', async () => {
        const h = createHarness({
            get: vi.fn().mockRejectedValue(new ApiError(404, { error: { code: 'thread_not_found', message: 'unknown' } })),
        });
        await h.controller.open('t-new');
        expect(h.store.getState().phase).toBe('empty');
        h.controller.dispose();
    });

    it('服务不可达：phase=error', async () => {
        const h = createHarness({
            get: vi.fn().mockRejectedValue(new ApiError(0, { error: { code: 'network_error', message: 'down' } })),
        });
        await h.controller.open('t1');
        expect(h.store.getState().phase).toBe('error');
        expect(h.store.getState().loadError).toMatchObject({ code: 'network_error' });
        h.controller.dispose();
    });
});

/** 从 POST /agui 请求体提取 {threadId, runId}，供假 SSE 流回显（服务端契约：回显客户端 runId） */
function requestBody(init: RequestInit | undefined): { threadId: string; runId: string } {
    return JSON.parse(String(init?.body)) as { threadId: string; runId: string };
}

describe('ThreadController.send', () => {
    it('happy path：POST /agui 只带最后一条 user 消息，流至终态', async () => {
        const h = createHarness();
        h.fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            const { runId } = requestBody(init);
            return sseResponse([
                frame({ type: 'RUN_STARTED', threadId: 'auto', runId, timestamp: 0 }, '1-0'),
                frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '答案', timestamp: 0 }, '1-1'),
                frame({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: '什么是 BM25' }], timestamp: 0 }, '1-2'),
                frame({ type: 'RUN_FINISHED', threadId: 'auto', runId, timestamp: 0 }, '1-3'),
            ]);
        });
        await h.controller.send('什么是 BM25');
        const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://api.test/agui');
        const body = JSON.parse(String(init.body)) as { threadId: string; messages: Array<{ role: string; content: string }> };
        expect(body.threadId).toMatch(/[0-9a-f-]{36}/);
        expect(body.messages).toEqual([{ id: expect.any(String), role: 'user', content: '什么是 BM25' }]);
        const state = h.store.getState();
        expect(state.turns).toHaveLength(1);
        expect(state.turns[0]).toMatchObject({ userText: '什么是 BM25', status: 'done' });
        expect(state.activeRunId).toBeNull();
        h.controller.dispose();
    });

    it('429：乐观 Turn 置错（服务繁忙）', async () => {
        const h = createHarness();
        h.fetchMock.mockResolvedValueOnce(
            jsonResponse(429, { error: { code: 'too_many_concurrent', message: 'max' } }, { 'Retry-After': '5' }),
        );
        await h.controller.send('问题');
        const turn = h.store.getState().turns[0]!;
        expect(turn.status).toBe('error');
        expect(turn.error?.message).toContain('服务繁忙');
        expect(turn.error?.message).toContain('5');
        h.controller.dispose();
    });

    it('409 run_already_active：置错并转 attach 跟随活跃 run', async () => {
        const h = createHarness({ get: vi.fn().mockResolvedValue(META_RUNNING) });
        h.fetchMock
            .mockResolvedValueOnce(
                jsonResponse(409, { error: { code: 'run_already_active', message: 'active' }, runId: 'r-other' }),
            )
            .mockResolvedValueOnce(
                sseResponse([
                    frame({ type: 'RUN_STARTED', threadId: 't1', runId: 'r-other', timestamp: 0 }, '1-0'),
                    frame({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r-other', timestamp: 0 }, '1-1'),
                ]),
            );
        await h.controller.send('重复提问');
        const state = h.store.getState();
        expect(state.turns).toHaveLength(2);
        expect(state.turns[0]).toMatchObject({ status: 'error', userText: '重复提问' });
        expect(state.turns[1]).toMatchObject({ runId: 'r-other', status: 'done' });
        h.controller.dispose();
    });

    it('流早断（未见终态）→ 读通道按游标续传补齐', async () => {
        const h = createHarness({ get: vi.fn().mockResolvedValue(META_RUNNING) });
        h.fetchMock
            // POST 流：连接中断，只送到一半（无终态）
            .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
                const { runId } = requestBody(init);
                return sseResponse([
                    frame({ type: 'RUN_STARTED', threadId: 't1', runId, timestamp: 0 }, '1-0'),
                    frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant', timestamp: 0 }, '1-1'),
                    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '前半', timestamp: 0 }, '1-2'),
                ]);
            })
            // 续传：从游标 1-2 之后回放，补齐到终态
            .mockResolvedValueOnce(
                sseResponse([
                    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '后半', timestamp: 0 }, '1-3'),
                    frame({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: '问题' }], timestamp: 0 }, '1-4'),
                    frame({ type: 'RUN_FINISHED', threadId: 't1', runId: 'whatever', timestamp: 0 }, '1-5'),
                ]),
            );
        await h.controller.send('问题');
        const state = h.store.getState();
        expect(state.turns).toHaveLength(1);
        expect(state.turns[0]).toMatchObject({ status: 'done', userText: '问题' });
        const textBlock = state.turns[0]!.blocks.find((block) => block.kind === 'text');
        expect(textBlock).toMatchObject({ content: '前半后半' });
        // 续传请求携带最后游标
        expect(h.eventsUrls()[0]).toContain('afterEventId=1-2');
        h.controller.dispose();
    });

    it('流早断且服务端已无活跃 run（回放无终态）→ resolveStaleRun', async () => {
        const h = createHarness({ get: vi.fn().mockResolvedValue(META_IDLE) });
        h.fetchMock
            .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
                const { runId } = requestBody(init);
                return sseResponse([
                    frame({ type: 'RUN_STARTED', threadId: 't1', runId, timestamp: 0 }, '1-0'),
                    frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant', timestamp: 0 }, '1-1'),
                    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '半截', timestamp: 0 }, '1-2'),
                ]);
            })
            // 续传回放：无新增终态事件，服务端关流 → meta 裁决 activeRun 已空
            .mockResolvedValueOnce(sseResponse([]));
        await h.controller.send('问题');
        const turn = h.store.getState().turns[0]!;
        expect(turn.status).toBe('error');
        expect(turn.error?.message).toContain('状态未知');
        h.controller.dispose();
    });

    it('服务重启：续传回放消费补发的 RUN_ERROR{server_restart}', async () => {
        const h = createHarness();
        h.fetchMock
            .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
                const { runId } = requestBody(init);
                return sseResponse([
                    frame({ type: 'RUN_STARTED', threadId: 't1', runId, timestamp: 0 }, '1-0'),
                    frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant', timestamp: 0 }, '1-1'),
                    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '半截', timestamp: 0 }, '1-2'),
                ]);
            })
            // 重启后回放：进程启动时补发的 RUN_ERROR{server_restart}
            .mockResolvedValueOnce(
                sseResponse([frame({ type: 'RUN_ERROR', message: 'server restarted', code: 'server_restart', timestamp: 0 }, '1-3')]),
            );
        await h.controller.send('问题');
        const turn = h.store.getState().turns[0]!;
        expect(turn.status).toBe('error');
        expect(turn.error).toMatchObject({ code: 'server_restart' });
        expect(h.store.getState().activeRunId).toBeNull();
        h.controller.dispose();
    });
});

describe('hash 路由', () => {
    it('解析与生成互逆', () => {
        expect(parseThreadId('#/t/0f4c2a1e-1111-2222-3333-444455556666')).toBe('0f4c2a1e-1111-2222-3333-444455556666');
        expect(parseThreadId('#/')).toBeNull();
        expect(parseThreadId('')).toBeNull();
        expect(parseThreadId('#/t/')).toBeNull();
        expect(threadHash('abc')).toBe('#/t/abc');
        expect(threadHash(null)).toBe('#/');
    });
});
