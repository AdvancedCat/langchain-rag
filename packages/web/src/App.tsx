import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { navigateToThread, useChat, useHashRoute, useServiceStatus, useTheme, useThreads, useThreadsApi } from './hooks';

export function App() {
    const threadId = useHashRoute();
    const api = useThreadsApi();
    const { threads, refresh } = useThreads(api);
    const serviceStatus = useServiceStatus(api);
    const [theme, setTheme] = useTheme();
    // 移动端抽屉侧栏（<768px，设计规范 §7）
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const closeSidebar = () => setSidebarOpen(false);
    const drawerRef = useRef<HTMLElement>(null);
    const { state, controller } = useChat(threadId, (created) => {
        // 首次发送自建线程 → URL 同步（#/t/<id>），刷新可恢复
        navigateToThread(created);
        void refresh();
    });

    // 一轮结束（activeRunId → null）时刷新会话列表（标题/时间/条数）
    const wasActiveRef = useRef(false);
    useEffect(() => {
        if (wasActiveRef.current && state.activeRunId === null) void refresh();
        wasActiveRef.current = state.activeRunId !== null;
    }, [state.activeRunId, refresh]);

    // 抽屉打开时：焦点移入面板、Tab 困在面板内、锁 body 滚动、Escape 关闭；
    // 关闭时焦点归还打开它的触发元素（否则 aside 变 invisible 后焦点掉回 body，键盘用户从头 Tab）
    useEffect(() => {
        if (!sidebarOpen) return;
        const drawer = drawerRef.current;
        const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        drawer?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSidebarOpen(false);
                return;
            }
            if (event.key !== 'Tab' || !drawer) return;
            const focusable = Array.from(
                drawer.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'),
            ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || active === drawer)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = previousOverflow;
            if (trigger?.isConnected) trigger.focus();
        };
    }, [sidebarOpen]);

    const title = threads.find((thread) => thread.threadId === threadId)?.title ?? (threadId ? '会话' : '新对话');

    const handleDelete = async (id: string) => {
        try {
            await api.remove(id);
        } catch {
            // 删除失败：列表轮询会自行收敛，不打断交互
        }
        if (id === threadId) navigateToThread(null);
        void refresh();
    };

    const sidebarProps = {
        threads,
        currentThreadId: threadId,
        localActiveRun: state.activeRunId !== null,
        serviceStatus,
        theme,
        onToggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
        onDelete: (id: string) => void handleDelete(id),
    } as const;

    return (
        <div className="flex h-full w-full overflow-hidden">
            {/* 桌面常驻侧栏（≥768px） */}
            <div className="hidden h-full md:flex">
                <Sidebar {...sidebarProps} onSelect={navigateToThread} onNew={() => navigateToThread(null)} />
            </div>

            {/* 移动端抽屉（<768px）：scrim 点击/Esc/选中会话 关闭 */}
            <div className={`fixed inset-0 z-40 md:hidden ${sidebarOpen ? '' : 'pointer-events-none'}`} aria-hidden={!sidebarOpen}>
                <div
                    aria-hidden="true"
                    onClick={closeSidebar}
                    className={`absolute inset-0 bg-scrim transition-opacity motion-safe:duration-base ${
                        sidebarOpen ? 'opacity-100 motion-safe:ease-out' : 'opacity-0 motion-safe:ease-in'
                    }`}
                />
                <aside
                    ref={drawerRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-label="会话导航"
                    className={`absolute inset-y-0 left-0 flex w-[264px] flex-col bg-surface shadow-sm outline-none transition-[transform,visibility] motion-safe:duration-base ${
                        sidebarOpen ? 'visible translate-x-0 motion-safe:ease-out' : 'invisible -translate-x-full motion-safe:ease-in'
                    }`}
                >
                    <Sidebar
                        {...sidebarProps}
                        onSelect={(id) => {
                            navigateToThread(id);
                            closeSidebar();
                        }}
                        onNew={() => {
                            navigateToThread(null);
                            closeSidebar();
                        }}
                    />
                </aside>
            </div>

            <ChatView state={state} controller={controller} title={title} threadId={threadId} onOpenSidebar={() => setSidebarOpen(true)} />
        </div>
    );
}
