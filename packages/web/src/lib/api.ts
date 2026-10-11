// ============================================================================
// REST 客户端（threads 管理 / cancel / 探针）；统一错误映射 ApiError
// ============================================================================

import type { ApiErrorBody, ThreadListResponse, ThreadMeta } from '../types';

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly retryAfterSeconds?: number;
    /** run_already_active 附带的活跃 runId */
    readonly activeRunId?: string;

    constructor(status: number, body: ApiErrorBody | null, retryAfterSeconds?: number) {
        super(body?.error.message ?? `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.code = body?.error.code ?? 'http_error';
        this.retryAfterSeconds = retryAfterSeconds;
        this.activeRunId = body?.runId;
    }
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | null> {
    try {
        return (await res.json()) as ApiErrorBody;
    } catch {
        return null;
    }
}

async function request<T>(baseUrl: string, path: string, init: RequestInit | undefined, fetchImpl: typeof fetch): Promise<T> {
    let res: Response;
    try {
        res = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (cause) {
        throw new ApiError(0, { error: { code: 'network_error', message: cause instanceof Error ? cause.message : '网络错误' } });
    }
    if (!res.ok) {
        const retryAfter = res.headers.get('Retry-After');
        throw new ApiError(res.status, await parseErrorBody(res), retryAfter ? Number(retryAfter) : undefined);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

export interface ThreadsApi {
    list(cursor?: number, limit?: number): Promise<ThreadListResponse>;
    get(threadId: string): Promise<ThreadMeta>;
    remove(threadId: string): Promise<void>;
    cancelRun(threadId: string, runId: string): Promise<{ runId: string; status: string }>;
    health(): Promise<{ status: string }>;
    ready(): Promise<{ status: string }>;
}

export function createThreadsApi(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): ThreadsApi {
    return {
        list: (cursor, limit) =>
            request<ThreadListResponse>(baseUrl, `/threads?cursor=${cursor ?? 0}&limit=${limit ?? 50}`, undefined, fetchImpl),
        get: (threadId) => request<ThreadMeta>(baseUrl, `/threads/${threadId}`, undefined, fetchImpl),
        remove: async (threadId) => {
            await request<void>(baseUrl, `/threads/${threadId}`, { method: 'DELETE' }, fetchImpl);
        },
        cancelRun: (threadId, runId) =>
            request<{ runId: string; status: string }>(baseUrl, `/threads/${threadId}/runs/${runId}/cancel`, {
                method: 'POST',
            }, fetchImpl),
        health: () => request<{ status: string }>(baseUrl, '/health', undefined, fetchImpl),
        ready: () => request<{ status: string }>(baseUrl, '/ready', undefined, fetchImpl),
    };
}
