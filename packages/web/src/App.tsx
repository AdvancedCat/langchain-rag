import { useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { navigateToThread, useChat, useHashRoute, useServiceStatus, useThreads, useThreadsApi } from './hooks';

export function App() {
    const threadId = useHashRoute();
    const api = useThreadsApi();
    const { threads, refresh } = useThreads(api);
    const serviceStatus = useServiceStatus(api);
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

    return (
        <div className="flex h-full w-full overflow-hidden">
            <Sidebar
                threads={threads}
                currentThreadId={threadId}
                localActiveRun={state.activeRunId !== null}
                serviceStatus={serviceStatus}
                onSelect={navigateToThread}
                onNew={() => navigateToThread(null)}
                onDelete={(id) => void handleDelete(id)}
            />
            <ChatView state={state} controller={controller} title={title} threadId={threadId} />
        </div>
    );
}
