import type { ThreadListItem } from '../types';
import type { ServiceStatus, ThemeChoice } from '../hooks';
import { BrandMark } from './BrandMark';
import { IconMoon, IconPlus, IconSun, IconTrash } from './icons';
import { Tooltip } from './Tooltip';

function relativeTime(iso: string): string {
    const deltaMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN');
}

const STATUS_META: Record<ServiceStatus, { color: string; text: string }> = {
    checking: { color: 'bg-line-strong', text: '检测服务中…' },
    ready: { color: 'bg-success', text: '服务正常' },
    degraded: { color: 'bg-warning', text: '服务降级（未就绪）' },
    down: { color: 'bg-danger', text: '服务不可达' },
};

export function Sidebar({
    threads,
    currentThreadId,
    localActiveRun,
    serviceStatus,
    theme,
    onSelect,
    onNew,
    onDelete,
    onToggleTheme,
}: {
    threads: ThreadListItem[];
    currentThreadId: string | null;
    localActiveRun: boolean;
    serviceStatus: ServiceStatus;
    theme: ThemeChoice;
    onSelect: (threadId: string) => void;
    onNew: () => void;
    onDelete: (threadId: string) => void;
    onToggleTheme: () => void;
}) {
    const status = STATUS_META[serviceStatus];
    return (
        <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-surface">
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg">
                    <BrandMark className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-content">文档问答</div>
                    <div className="text-[11px] text-content-muted">RAG Agent</div>
                </div>
            </div>

            <div className="px-3 pb-2">
                <button
                    type="button"
                    onClick={onNew}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm font-medium text-content shadow-sm transition hover:border-accent hover:text-accent"
                >
                    <IconPlus />
                    新对话
                </button>
            </div>

            <nav className="thin-scrollbar flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
                {threads.length === 0 && (
                    <p className="px-2 py-6 text-center text-xs text-content-secondary">暂无历史会话</p>
                )}
                {threads.map((thread) => {
                    const active = thread.threadId === currentThreadId;
                    const running = thread.activeRun !== null || (active && localActiveRun);
                    return (
                        <div
                            key={thread.threadId}
                            role="button"
                            tabIndex={0}
                            aria-current={active ? 'true' : undefined}
                            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
                                active ? 'bg-accent-soft text-accent' : 'text-content-secondary hover:bg-inset'
                            }`}
                            onClick={() => onSelect(thread.threadId)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onSelect(thread.threadId);
                                }
                            }}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{thread.title ?? '未命名会话'}</div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-content-secondary">
                                    <span>{relativeTime(thread.updatedAt)}</span>
                                    <span>· {thread.messageCount} 条</span>
                                </div>
                            </div>
                            {running && (
                                <span className="flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success-fg">
                                    <span className="h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-success" />
                                    运行中
                                </span>
                            )}
                            <Tooltip label="删除会话">
                                <button
                                    type="button"
                                    aria-label="删除会话"
                                    className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-muted opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-content/10 hover:text-danger"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onDelete(thread.threadId);
                                    }}
                                >
                                    <IconTrash />
                                </button>
                            </Tooltip>
                        </div>
                    );
                })}
            </nav>

            <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-content-secondary">
                <span className={`h-2 w-2 rounded-full ${status.color}`} />
                {status.text}
                <Tooltip label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'} placement="top" className="ml-auto">
                    <button
                        type="button"
                        onClick={onToggleTheme}
                        aria-label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
                        className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-content-secondary transition hover:bg-content/10 hover:text-content"
                    >
                        {theme === 'dark' ? <IconSun /> : <IconMoon />}
                    </button>
                </Tooltip>
            </div>
        </aside>
    );
}
