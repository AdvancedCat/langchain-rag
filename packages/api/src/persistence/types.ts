// ============================================================================
// 持久化契约（方案 §7）：事件日志（Redis Stream）、会话元数据、run 记录
//
// 接口先行：memory 实现服务单测（fake），redis 实现服务生产与集成测试。
// P2 起事件先落 Stream 再扇出（XADD 先行），SSE 的 id: 即 Stream entry id。
// ============================================================================

import type { Event as AguiEvent, Message } from '@ag-ui/core';

export interface EventRecord {
    /** Redis Stream entry id，即前端续传游标 */
    id: string;
    event: AguiEvent;
}

export interface ThreadMeta {
    threadId: string;
    title: string | null;
    createdAt: number;
    updatedAt: number;
    lastEventId: string | null;
    messageCount: number;
}

export interface RunRecord {
    runId: string;
    threadId: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    error?: string;
}

export interface Persistence {
    /** 事件追加进 thread 日志；返回 eventId。顺带刷新 thread 的 updatedAt/lastEventId 与 TTL */
    appendEvent(threadId: string, event: AguiEvent): Promise<string>;
    /** 回放：afterEventId 为空 = 全量；否则从该 id 之后（不含） */
    readEvents(threadId: string, afterEventId?: string): Promise<EventRecord[]>;
    /** 最近一次 MESSAGES_SNAPSHOT 的 messages（/messages 端点用；无则 null） */
    latestSnapshot(threadId: string): Promise<Message[] | null>;
    /** thread 不存在则建档；存在且 title 为空且 init.title 给定则回填 */
    ensureThread(threadId: string, init?: { title?: string }): Promise<ThreadMeta>;
    getThread(threadId: string): Promise<ThreadMeta | null>;
    listThreads(offset: number, limit: number): Promise<{ items: ThreadMeta[]; nextOffset: number | null }>;
    /** 终态时更新消息计数 */
    updateMessageCount(threadId: string, count: number): Promise<void>;
    /** 删除会话（事件+元数据+索引）；返回是否存在 */
    deleteThread(threadId: string): Promise<boolean>;

    createRun(runId: string, threadId: string): Promise<void>;
    finishRun(runId: string, status: string, error?: string): Promise<void>;
    /**
     * 启动时扫描遗留的 running run（上次进程未优雅退出）：
     * 逐个置 interrupted 并回调补发 RUN_ERROR{server_restart}（实现内部以
     * SETNX finalized 标记保证幂等）。返回处理数量。
     */
    markInterruptedRuns(onInterrupt: (runId: string, threadId: string) => Promise<void>): Promise<number>;

    close(): Promise<void>;
}
