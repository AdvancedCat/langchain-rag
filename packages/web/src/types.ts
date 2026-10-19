// ============================================================================
// API 契约类型（对齐 packages/api 实现与 docs/api-service-plan.md §5/§6；
// 事实以服务端代码为准：SSE 帧仅 data: 行，type 为 SCREAMING_SNAKE 字符串）
// ============================================================================

/** AG-UI 消息（MESSAGES_SNAPSHOT / GET /threads/:id/messages 返回体） */
export interface AguiMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCallId?: string;
}

// ---- AG-UI 事件（本项目服务端实际发射的子集 + 自有扩展字段） ----

interface BaseEvent {
    type: string;
    timestamp: number;
}

export interface RunStartedEvent extends BaseEvent {
    type: 'RUN_STARTED';
    threadId: string;
    runId: string;
}

export interface RunFinishedEvent extends BaseEvent {
    type: 'RUN_FINISHED';
    threadId: string;
    runId: string;
    outcome?: { type: string };
}

/** code ∈ {timeout, cancelled, server_error, server_restart}（server_restart 为重启补发） */
export interface RunErrorEvent extends BaseEvent {
    type: 'RUN_ERROR';
    threadId?: string;
    runId?: string;
    message: string;
    code?: string;
}

export interface MessagesSnapshotEvent extends BaseEvent {
    type: 'MESSAGES_SNAPSHOT';
    messages: AguiMessage[];
}

export interface TextMessageStartEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_START';
    messageId: string;
    role: string;
    subagentRunId?: string;
}

export interface TextMessageContentEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_CONTENT';
    messageId: string;
    delta: string;
    subagentRunId?: string;
}

export interface TextMessageEndEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_END';
    messageId: string;
    subagentRunId?: string;
}

export interface ReasoningMessageStartEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_START';
    messageId: string;
    role: string;
    subagentRunId?: string;
}

export interface ReasoningMessageContentEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_CONTENT';
    messageId: string;
    delta: string;
    subagentRunId?: string;
}

export interface ReasoningMessageEndEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_END';
    messageId: string;
    subagentRunId?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
    type: 'TOOL_CALL_START';
    toolCallId: string;
    toolCallName: string;
    parentMessageId?: string;
    subagentRunId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
    type: 'TOOL_CALL_ARGS';
    toolCallId: string;
    delta: string;
    subagentRunId?: string;
}

export interface ToolCallEndEvent extends BaseEvent {
    type: 'TOOL_CALL_END';
    toolCallId: string;
    subagentRunId?: string;
}

export interface ToolCallResultEvent extends BaseEvent {
    type: 'TOOL_CALL_RESULT';
    messageId: string;
    toolCallId: string;
    content: string;
    role: string;
}

/** v1.0 扩展事件：子代理（chunk-analyst）启停 */
export interface SubagentStartedEvent extends BaseEvent {
    type: 'SUBAGENT_STARTED';
    subagentRunId: string;
    name: string;
    parentToolCallId: string;
}

export interface SubagentFinishedEvent extends BaseEvent {
    type: 'SUBAGENT_FINISHED';
    subagentRunId: string;
    result?: string;
    outcome?: { type: string };
}

/** retrieval.trace（M9-P3 项，当前服务端不发射；渲染占位） */
export interface RetrievalTrace {
    stage?: string;
    query?: string;
    rewrittenQuery?: string;
    candidates?: number;
    topK?: number;
    gate?: { signal?: string; score?: number; threshold?: number; decision?: string };
    chunks?: Array<{ path: string; source?: string; sectionPath?: string[]; score?: number }>;
}

/** cozeloop.trace：本轮 run 的 CozeLoop traceId（复制到罗盘后台检索） */
export interface CozeLoopTraceValue {
    traceId: string;
    runId?: string;
}

/** CUSTOM 载荷按 name 分派（retrieval.trace / cozeloop.trace），消费侧自行收窄 */
export interface CustomEvent extends BaseEvent {
    type: 'CUSTOM';
    name: string;
    value?: RetrievalTrace & Record<string, unknown>;
}

export type AguiEvent =
    | RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | MessagesSnapshotEvent
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | ReasoningMessageStartEvent
    | ReasoningMessageContentEvent
    | ReasoningMessageEndEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | ToolCallResultEvent
    | SubagentStartedEvent
    | SubagentFinishedEvent
    | CustomEvent;

// ---- REST 类型 ----

export interface ActiveRun {
    runId: string;
    status: string;
}

export interface ThreadMeta {
    threadId: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
    lastEventId?: string;
    messageCount?: number;
    activeRun?: ActiveRun | null;
}

export interface ThreadListItem {
    threadId: string;
    title: string | null;
    updatedAt: string;
    messageCount: number;
    activeRun: ActiveRun | null;
}

export interface ThreadListResponse {
    items: ThreadListItem[];
    nextCursor: number | null;
}

export interface ApiErrorBody {
    error: { code: string; message: string };
    /** run_already_active 附带的活跃 runId */
    runId?: string;
}
