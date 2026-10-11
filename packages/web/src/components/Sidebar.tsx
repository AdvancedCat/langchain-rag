import type { ThreadListItem } from '../types';
import type { ServiceStatus } from '../hooks';
import { IconPlus, IconTrash } from './icons';

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
    checking: { color: 'bg-zinc-300', text: '检测服务中…' },
    ready: { color: 'bg-emerald-500', text: '服务正常' },
    degraded: { color: 'bg-amber-500', text: '服务降级（未就绪）' },
    down: { color: 'bg-red-500', text: '服务不可达' },
};

export function Sidebar({
    threads,
    currentThreadId,
    localActiveRun,
    serviceStatus,
    onSelect,
    onNew,
    onDelete,
}: {
    threads: ThreadListItem[];
    currentThreadId: string | null;
    localActiveRun: boolean;
    serviceStatus: ServiceStatus;
    onSelect: (threadId: string) => void;
    onNew: () => void;
    onDelete: (threadId: string) => void;
}) {
    const status = STATUS_META[serviceStatus];
    return (
        <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">R</span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-800">文档问答</div>
                    <div className="text-[11px] text-zinc-400">RAG Agent</div>
                </div>
            </div>

            <div className="px-3 pb-2">
                <button
                    type="button"
                    onClick={onNew}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600"
                >
                    <IconPlus />
                    新对话
                </button>
            </div>

            <nav className="thin-scrollbar flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
                {threads.length === 0 && (
                    <p className="px-2 py-6 text-center text-xs text-zinc-400">暂无历史会话</p>
                )}
                {threads.map((thread) => {
                    const active = thread.threadId === currentThreadId;
                    const running = thread.activeRun !== null || (active && localActiveRun);
                    return (
                        <div
                            key={thread.threadId}
                            className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
                                active ? 'bg-indigo-50 text-indigo-700' : 'text-zinc-600 hover:bg-zinc-100'
                            }`}
                            onClick={() => onSelect(thread.threadId)}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{thread.title ?? '未命名会话'}</div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
                                    <span>{relativeTime(thread.updatedAt)}</span>
                                    <span>· {thread.messageCount} 条</span>
                                </div>
                            </div>
                            {running && (
                                <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                                    运行中
                                </span>
                            )}
                            <button
                                type="button"
                                title="删除会话"
                                className="shrink-0 rounded p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-200 hover:text-red-600"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDelete(thread.threadId);
                                }}
                            >
                                <IconTrash />
                            </button>
                        </div>
                    );
                })}
            </nav>

            <div className="flex items-center gap-2 border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500">
                <span className={`h-2 w-2 rounded-full ${status.color}`} />
                {status.text}
            </div>
        </aside>
    );
}
