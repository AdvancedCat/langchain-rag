// ============================================================================
// React 集成 hooks：hash 路由、chat store/controller 桥接、会话列表与服务状态
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createChatStore, type ChatState, type ChatStore } from './lib/chatStore';
import { createThreadsApi, type ThreadsApi } from './lib/api';
import { ThreadController } from './lib/threadController';
import { parseThreadId, threadHash } from './router';
import { API_BASE_URL } from './env';
import type { ThreadListItem } from './types';

export function useThreadsApi(): ThreadsApi {
    return useMemo(() => createThreadsApi(API_BASE_URL), []);
}

/** #/ ↔ #/t/<threadId>；返回 null 表示新对话 */
export function useHashRoute(): string | null {
    const [threadId, setThreadId] = useState<string | null>(() => parseThreadId(window.location.hash));
    useEffect(() => {
        const onChange = () => setThreadId(parseThreadId(window.location.hash));
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);
    return threadId;
}

export function navigateToThread(threadId: string | null): void {
    const next = threadHash(threadId);
    if (window.location.hash !== next) window.location.hash = next;
}

/**
 * 打开线程的 chat 状态 + 控制器。
 * threadId 变化 → controller.open（send 自建线程时 open 幂等跳过）。
 */
export function useChat(threadId: string | null, onThreadCreated: (threadId: string) => void) {
    const storeRef = useRef<ChatStore | null>(null);
    if (storeRef.current === null) storeRef.current = createChatStore();
    const store = storeRef.current;

    const createdCallbackRef = useRef(onThreadCreated);
    createdCallbackRef.current = onThreadCreated;

    const controllerRef = useRef<ThreadController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = new ThreadController({
            baseUrl: API_BASE_URL,
            threadId,
            store,
            api: createThreadsApi(API_BASE_URL),
            onThreadCreated: (id) => createdCallbackRef.current(id),
        });
    }

    useEffect(() => {
        void controllerRef.current?.open(threadId);
    }, [threadId]);

    useEffect(() => () => controllerRef.current?.dispose(), []);

    const state: ChatState = useSyncExternalStore(store.subscribe, store.getState);
    return { state, controller: controllerRef.current };
}

/** 会话列表（10s 轮询 + 手动刷新） */
export function useThreads(api: ThreadsApi) {
    const [threads, setThreads] = useState<ThreadListItem[]>([]);
    const [error, setError] = useState(false);
    const refresh = useCallback(async () => {
        try {
            const response = await api.list();
            setThreads(response.items);
            setError(false);
        } catch {
            setError(true);
        }
    }, [api]);
    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 10_000);
        return () => clearInterval(timer);
    }, [refresh]);
    return { threads, error, refresh };
}

export type ServiceStatus = 'checking' | 'ready' | 'degraded' | 'down';

/** 服务状态点：/health + /ready 双探针，30s 轮询 */
export function useServiceStatus(api: ThreadsApi): ServiceStatus {
    const [status, setStatus] = useState<ServiceStatus>('checking');
    useEffect(() => {
        let cancelled = false;
        const probe = async () => {
            let next: ServiceStatus = 'down';
            try {
                await api.health();
                next = 'degraded';
                const ready = await api.ready();
                if (ready.status === 'ready') next = 'ready';
            } catch {
                next = 'down';
            }
            if (!cancelled) setStatus(next);
        };
        void probe();
        const timer = setInterval(() => void probe(), 30_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [api]);
    return status;
}
