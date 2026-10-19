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

/** 主题选择：深色模式按 html.dark 类切换（MASTER §2），手动选择存 localStorage */
export type ThemeChoice = 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme';

function resolveTheme(): ThemeChoice {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 默认跟随 prefers-color-scheme；手动选择后系统变化不再跟随 */
export function useTheme(): [ThemeChoice, (theme: ThemeChoice) => void] {
    const [theme, setTheme] = useState<ThemeChoice>(resolveTheme);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (localStorage.getItem(THEME_STORAGE_KEY) !== null) return;
            const next = resolveTheme();
            document.documentElement.classList.toggle('dark', next === 'dark');
            setTheme(next);
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, []);
    const apply = (next: ThemeChoice) => {
        localStorage.setItem(THEME_STORAGE_KEY, next);
        document.documentElement.classList.toggle('dark', next === 'dark');
        setTheme(next);
    };
    return [theme, apply];
}

/**
 * 复制反馈（MASTER §7 通用交互模式）：点击复制后 copied 置 true，
 * ≤1.6s 自动回退；调用方负责控件尺寸不变（无布局位移）。
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timerRef.current), []);
    const copy = useCallback((text: string) => {
        void navigator.clipboard
            ?.writeText(text)
            .then(() => {
                setCopied(true);
                clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => undefined);
    }, []);
    return { copied, copy };
}

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
