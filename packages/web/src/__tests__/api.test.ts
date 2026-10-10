import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createThreadsApi } from '../lib/api';

const fetchMock = vi.fn();

async function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Promise<Response> {
    return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
    fetchMock.mockReset();
});

describe('ThreadsApi', () => {
    it('列表与详情正常解析', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse(200, { items: [{ threadId: 't1', title: null, updatedAt: '2026-10-10T00:00:00Z', messageCount: 2, activeRun: null }], nextCursor: null }),
            )
            .mockResolvedValueOnce(jsonResponse(200, { threadId: 't1', title: '标题', createdAt: '', updatedAt: '', activeRun: { runId: 'r1', status: 'running' } }));
        const api = createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch);
        const list = await api.list();
        expect(list.items[0]?.threadId).toBe('t1');
        const meta = await api.get('t1');
        expect(meta.activeRun?.runId).toBe('r1');
        expect(fetchMock.mock.calls[1]?.[0]).toBe('http://api.test/threads/t1');
    });

    it('错误体映射为 ApiError（code/message/Retry-After/活跃 runId）', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(429, { error: { code: 'too_many_concurrent', message: 'server is at max concurrent runs' } }, { 'Retry-After': '5' }),
        );
        const api = createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch);
        const error = (await api.list().catch((e: unknown) => e)) as ApiError;
        expect(error).toBeInstanceOf(ApiError);
        expect(error.code).toBe('too_many_concurrent');
        expect(error.status).toBe(429);
        expect(error.retryAfterSeconds).toBe(5);
    });

    it('run_already_active 附带活跃 runId', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(409, { error: { code: 'run_already_active', message: 'thread already has an active run' }, runId: 'r-active' }),
        );
        const api = createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch);
        const error = (await api.get('t1').catch((e: unknown) => e)) as ApiError;
        expect(error.code).toBe('run_already_active');
        expect(error.activeRunId).toBe('r-active');
    });

    it('网络异常映射 network_error', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        const api = createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch);
        const error = (await api.health().catch((e: unknown) => e)) as ApiError;
        expect(error).toBeInstanceOf(ApiError);
        expect(error.code).toBe('network_error');
    });

    it('DELETE 204 返回 undefined', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        const api = createThreadsApi('http://api.test', fetchMock as unknown as typeof fetch);
        await expect(api.remove('t1')).resolves.toBeUndefined();
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    });
});
