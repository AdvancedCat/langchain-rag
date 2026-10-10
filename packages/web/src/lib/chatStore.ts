// ============================================================================
// chatStore：AG-UI 事件流 → 会话视图模型（设计决策 F3/F5，frontend-plan.md §5）
//
// 纯函数归约（applyEvents），配合一个极简可观察 store（React 经
// useSyncExternalStore 消费）。关键规则：
//
// - 按 eventId（Redis Stream entry id）幂等去重——POST /agui 与 GET /events
//   两通道可能重复投递同一事件；
// - 一次 run = 一个 Turn；TEXT/REASONING 共享 messageId 但按 kind 区分定位；
// - 子代理事件（携 subagentRunId）路由进 SubagentBlock.blocks；
//   TOOL_CALL_RESULT 不带 subagentRunId，按 toolCallId 全局嵌套查找；
// - MESSAGES_SNAPSHOT 只回填当前 Turn 的 userText（事件流不含用户消息；
//   snapshot 会把 tool_calls 的 assistant 压平为空文本，不能替换渲染）；
// - RUN_ERROR code=cancelled → status='cancelled'（非错误）。
// ============================================================================

import type {
    AguiEvent,
    CustomEvent,
    MessagesSnapshotEvent,
    RetrievalTrace,
    RunErrorEvent,
    TextMessageStartEvent,
    ReasoningMessageStartEvent,
    SubagentFinishedEvent,
    SubagentStartedEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
} from '../types';

export type TurnStatus = 'streaming' | 'done' | 'error' | 'cancelled';

export interface ReasoningBlock {
    kind: 'reasoning';
    messageId: string;
    content: string;
    done: boolean;
}

export interface TextBlock {
    kind: 'text';
    messageId: string;
    content: string;
    done: boolean;
}

export interface ToolCallBlock {
    kind: 'toolcall';
    toolCallId: string;
    name: string;
    args: string;
    result: string | null;
    done: boolean;
}

export interface SubagentBlock {
    kind: 'subagent';
    subagentRunId: string;
    name: string;
    parentToolCallId: string;
    finished: boolean;
    blocks: ChatBlock[];
}

export type ChatBlock = ReasoningBlock | TextBlock | ToolCallBlock | SubagentBlock;

export interface Turn {
    runId: string;
    /** 事件流不含用户消息：发送时乐观插入，回放时由 MESSAGES_SNAPSHOT 回填 */
    userText: string | null;
    blocks: ChatBlock[];
    status: TurnStatus;
    error?: { code?: string; message: string };
    /** CUSTOM retrieval.trace（M9-P3 项，当前通常为空） */
    trace?: RetrievalTrace;
}

export type ChannelState = { state: 'ok' } | { state: 'reconnecting'; attempt: number };

export interface ChatState {
    /** empty=空会话（尚无任何 run） loading=回放中 ready=可交互 error=打开失败（可重试） */
    phase: 'empty' | 'loading' | 'ready' | 'error';
    loadError: { code?: string; message: string } | null;
    turns: Turn[];
    activeRunId: string | null;
    lastEventId: string;
    seenEventIds: Set<string>;
    channel: ChannelState;
}

export interface IncomingEvent {
    eventId?: string;
    event: AguiEvent;
}

export type ChatAction =
    | { type: 'reset'; phase: ChatState['phase'] }
    | { type: 'loadFailed'; error: { code?: string; message: string } }
    | { type: 'optimisticSend'; runId: string; text: string }
    | { type: 'sendFailed'; runId: string; error: { code?: string; message: string } }
    | { type: 'resolveStaleRun' }
    | { type: 'events'; batch: IncomingEvent[] }
    | { type: 'channel'; channel: ChannelState };

export function initialChatState(phase: ChatState['phase'] = 'loading'): ChatState {
    return {
        phase,
        loadError: null,
        turns: [],
        activeRunId: null,
        lastEventId: '',
        seenEventIds: new Set(),
        channel: { state: 'ok' },
    };
}

// ---------------------------------------------------------------------------
// 不可变更新的小工具：返回浅拷贝，改动沿路径传播
// ---------------------------------------------------------------------------

function touchTurn(state: ChatState, index: number, mutate: (turn: Turn) => Turn): ChatState {
    const turns = state.turns.map((turn, i) => (i === index ? mutate(turn) : turn));
    return { ...state, turns };
}

function touchTurnBlocks(turn: Turn, mutate: (blocks: ChatBlock[]) => ChatBlock[]): Turn {
    return { ...turn, blocks: mutate(turn.blocks) };
}

/** 在顶层或子代理嵌套中按谓词查找 block，返回 [turn 索引, 容器 blocks, block] */
function findBlock(
    state: ChatState,
    predicate: (block: ChatBlock) => boolean,
): { turnIndex: number; turn: Turn; blocks: ChatBlock[]; index: number; block: ChatBlock } | null {
    for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex--) {
        const turn = state.turns[turnIndex] as Turn;
        for (let index = 0; index < turn.blocks.length; index++) {
            const block = turn.blocks[index] as ChatBlock;
            if (predicate(block)) {
                return { turnIndex, turn, blocks: turn.blocks, index, block };
            }
            if (block.kind === 'subagent') {
                const innerIndex = block.blocks.findIndex(predicate);
                if (innerIndex !== -1) {
                    return { turnIndex, turn, blocks: block.blocks, index: innerIndex, block: block.blocks[innerIndex] as ChatBlock };
                }
            }
        }
    }
    return null;
}

/** 找 turn 内指定 id 的子代理 block（子代理只出现在 turn 顶层，不嵌套） */
function findSubagent(turn: Turn, subagentRunId: string): SubagentBlock | null {
    const block = turn.blocks.find((b): b is SubagentBlock => b.kind === 'subagent' && b.subagentRunId === subagentRunId);
    return block ?? null;
}

/** 目标容器：携 subagentRunId 的事件路由进该子代理的嵌套 blocks，否则进 turn.blocks */
function targetBlocks(state: ChatState, turnIndex: number, subagentRunId?: string): ChatBlock[] | null {
    const turn = state.turns[turnIndex];
    if (!turn) return null;
    if (!subagentRunId) return turn.blocks;
    // 丢失 SUBAGENT_STARTED（乱序）时降级到顶层
    return findSubagent(turn, subagentRunId)?.blocks ?? turn.blocks;
}

// ---------------------------------------------------------------------------
// 事件归约
// ---------------------------------------------------------------------------

export function applyEvents(state: ChatState, batch: IncomingEvent[]): ChatState {
    let next = state;
    for (const incoming of batch) {
        next = applyEvent(next, incoming);
    }
    return next;
}

function applyEvent(state: ChatState, { eventId, event }: IncomingEvent): ChatState {
    if (eventId !== undefined) {
        if (state.seenEventIds.has(eventId)) return state;
        state = {
            ...state,
            seenEventIds: new Set(state.seenEventIds).add(eventId),
            lastEventId: eventId,
        };
    }
    switch (event.type) {
        case 'RUN_STARTED':
            return onRunStarted(state, event);
        case 'TEXT_MESSAGE_START':
            return onMessageStart(state, event, 'text');
        case 'TEXT_MESSAGE_CONTENT':
            return onMessageContent(state, event.messageId, event.delta, 'text');
        case 'TEXT_MESSAGE_END':
            return onMessageEnd(state, event.messageId, 'text');
        case 'REASONING_MESSAGE_START':
            return onMessageStart(state, event, 'reasoning');
        case 'REASONING_MESSAGE_CONTENT':
            return onMessageContent(state, event.messageId, event.delta, 'reasoning');
        case 'REASONING_MESSAGE_END':
            return onMessageEnd(state, event.messageId, 'reasoning');
        case 'TOOL_CALL_START':
            return onToolCallStart(state, event);
        case 'TOOL_CALL_ARGS':
            return onToolCallArgs(state, event);
        case 'TOOL_CALL_END':
            return onToolCallEnd(state, event);
        case 'TOOL_CALL_RESULT':
            return onToolCallResult(state, event);
        case 'SUBAGENT_STARTED':
            return onSubagentStarted(state, event);
        case 'SUBAGENT_FINISHED':
            return onSubagentFinished(state, event);
        case 'MESSAGES_SNAPSHOT':
            return onSnapshot(state, event);
        case 'RUN_FINISHED':
            return onRunFinished(state);
        case 'RUN_ERROR':
            return onRunError(state, event);
        case 'CUSTOM':
            return onCustom(state, event);
        default:
            return state;
    }
}

function currentTurnIndex(state: ChatState): number {
    if (state.activeRunId !== null) {
        const index = state.turns.findIndex((turn) => turn.runId === state.activeRunId);
        if (index !== -1) return index;
    }
    return state.turns.length - 1;
}

function onRunStarted(state: ChatState, event: { runId: string }): ChatState {
    const existing = state.turns.findIndex((turn) => turn.runId === event.runId);
    if (existing !== -1) {
        // optimisticSend 已建 Turn（本端发送）——保留 userText，仅确保 streaming
        return touchTurn(state, existing, (turn) => (turn.status === 'streaming' ? turn : { ...turn, status: 'streaming' }));
    }
    return {
        ...state,
        phase: 'ready',
        activeRunId: event.runId,
        turns: [...state.turns, { runId: event.runId, userText: null, blocks: [], status: 'streaming' }],
    };
}

function onMessageStart(
    state: ChatState,
    event: TextMessageStartEvent | ReasoningMessageStartEvent,
    kind: 'text' | 'reasoning',
): ChatState {
    const turnIndex = currentTurnIndex(state);
    const container = targetBlocks(state, turnIndex, event.subagentRunId);
    if (container === null) return state;
    if (container.some((block) => (block.kind === 'text' || block.kind === 'reasoning') && block.messageId === event.messageId && block.kind === kind)) {
        return state;
    }
    const block: TextBlock | ReasoningBlock =
        kind === 'text'
            ? { kind: 'text', messageId: event.messageId, content: '', done: false }
            : { kind: 'reasoning', messageId: event.messageId, content: '', done: false };
    const appended = [...container, block];
    return attachContainer(state, turnIndex, event.subagentRunId, appended);
}

function onMessageContent(state: ChatState, messageId: string, delta: string, kind: 'text' | 'reasoning'): ChatState {
    const found = findBlock(
        state,
        (block) => (block.kind === 'text' || block.kind === 'reasoning') && block.messageId === messageId && block.kind === kind,
    );
    if (!found) return state;
    const updated = found.blocks.map((block, i) =>
        i === found.index && (block.kind === 'text' || block.kind === 'reasoning') ? { ...block, content: block.content + delta } : block,
    );
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function onMessageEnd(state: ChatState, messageId: string, kind: 'text' | 'reasoning'): ChatState {
    const found = findBlock(
        state,
        (block) => (block.kind === 'text' || block.kind === 'reasoning') && block.messageId === messageId && block.kind === kind,
    );
    if (!found) return state;
    const updated = found.blocks.map((block, i) =>
        i === found.index && (block.kind === 'text' || block.kind === 'reasoning') ? { ...block, done: true } : block,
    );
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function onToolCallStart(state: ChatState, event: ToolCallStartEvent): ChatState {
    const turnIndex = currentTurnIndex(state);
    const container = targetBlocks(state, turnIndex, event.subagentRunId);
    if (container === null || container.some((block) => block.kind === 'toolcall' && block.toolCallId === event.toolCallId)) {
        return state;
    }
    const block: ToolCallBlock = {
        kind: 'toolcall',
        toolCallId: event.toolCallId,
        name: event.toolCallName,
        args: '',
        result: null,
        done: false,
    };
    return attachContainer(state, turnIndex, event.subagentRunId, [...container, block]);
}

function onToolCallArgs(state: ChatState, event: ToolCallArgsEvent): ChatState {
    const found = findToolCall(state, event.toolCallId);
    if (!found) return state;
    const updated = found.blocks.map((block, i) =>
        i === found.index && block.kind === 'toolcall' ? { ...block, args: block.args + event.delta } : block,
    );
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function onToolCallEnd(state: ChatState, event: ToolCallEndEvent): ChatState {
    const found = findToolCall(state, event.toolCallId);
    if (!found) return state;
    const updated = found.blocks.map((block, i) => (i === found.index && block.kind === 'toolcall' ? { ...block, done: true } : block));
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function onToolCallResult(state: ChatState, event: ToolCallResultEvent): ChatState {
    const found = findToolCall(state, event.toolCallId);
    if (!found) return state;
    const updated = found.blocks.map((block, i) =>
        i === found.index && block.kind === 'toolcall' ? { ...block, result: event.content ?? '', done: true } : block,
    );
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function findToolCall(state: ChatState, toolCallId: string) {
    return findBlock(state, (block) => block.kind === 'toolcall' && block.toolCallId === toolCallId);
}

function onSubagentStarted(state: ChatState, event: SubagentStartedEvent): ChatState {
    const turnIndex = currentTurnIndex(state);
    const turn = state.turns[turnIndex];
    if (!turn) return state;
    if (turn.blocks.some((block) => block.kind === 'subagent' && block.subagentRunId === event.subagentRunId)) {
        return state;
    }
    const block: SubagentBlock = {
        kind: 'subagent',
        subagentRunId: event.subagentRunId,
        name: event.name,
        parentToolCallId: event.parentToolCallId,
        finished: false,
        blocks: [],
    };
    return touchTurn(state, turnIndex, (t) => touchTurnBlocks(t, (blocks) => [...blocks, block]));
}

function onSubagentFinished(state: ChatState, event: SubagentFinishedEvent): ChatState {
    const found = findBlock(state, (block) => block.kind === 'subagent' && block.subagentRunId === event.subagentRunId);
    if (!found) return state;
    const updated = found.blocks.map((block, i) =>
        i === found.index && block.kind === 'subagent' ? { ...block, finished: true } : block,
    );
    return replaceContainer(state, found.turnIndex, found.blocks, updated);
}

function onSnapshot(state: ChatState, event: MessagesSnapshotEvent): ChatState {
    const turnIndex = currentTurnIndex(state);
    if (turnIndex === -1) return state;
    const turn = state.turns[turnIndex];
    if (!turn || turn.userText !== null) return state;
    const lastUser = [...event.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return state;
    return touchTurn(state, turnIndex, (t) => ({ ...t, userText: lastUser.content }));
}

function onRunFinished(state: ChatState): ChatState {
    const turnIndex = currentTurnIndex(state);
    if (turnIndex === -1) return { ...state, activeRunId: null };
    return { ...touchTurn(state, turnIndex, (turn) => ({ ...turn, status: 'done' })), activeRunId: null };
}

function onRunError(state: ChatState, event: RunErrorEvent): ChatState {
    const turnIndex = currentTurnIndex(state);
    if (turnIndex === -1) return { ...state, activeRunId: null };
    const cancelled = event.code === 'cancelled';
    return {
        ...touchTurn(state, turnIndex, (turn) => ({
            ...turn,
            status: cancelled ? 'cancelled' : 'error',
            error: cancelled ? undefined : { code: event.code, message: event.message },
        })),
        activeRunId: null,
    };
}

function onCustom(state: ChatState, event: CustomEvent): ChatState {
    if (event.name !== 'retrieval.trace' || !event.value) return state;
    const turnIndex = currentTurnIndex(state);
    if (turnIndex === -1) return state;
    return touchTurn(state, turnIndex, (turn) => ({ ...turn, trace: event.value as RetrievalTrace }));
}

/** 把（可能嵌套在 SubagentBlock 内的）容器引用替换为更新后的副本 */
function replaceContainer(state: ChatState, turnIndex: number, container: ChatBlock[], updated: ChatBlock[]): ChatState {
    return touchTurn(state, turnIndex, (turn) =>
        touchTurnBlocks(turn, (blocks) => (blocks === container ? updated : spliceNested(blocks, container, updated))),
    );
}

/** append 后写回容器：嵌套时克隆所属子代理 block，顶层时替换 turn.blocks */
function attachContainer(state: ChatState, turnIndex: number, subagentRunId: string | undefined, appended: ChatBlock[]): ChatState {
    return touchTurn(state, turnIndex, (turn) => {
        if (!subagentRunId) return touchTurnBlocks(turn, () => appended);
        const owner = findSubagent(turn, subagentRunId);
        if (!owner) return touchTurnBlocks(turn, () => appended);
        return touchTurnBlocks(turn, (blocks) => blocks.map((block) => (block === owner ? { ...block, blocks: appended } : block)));
    });
}

function spliceNested(blocks: ChatBlock[], container: ChatBlock[], updated: ChatBlock[]): ChatBlock[] {
    return blocks.map((block) => {
        if (block.kind === 'subagent') {
            return block.blocks === container ? { ...block, blocks: updated } : { ...block, blocks: spliceNested(block.blocks, container, updated) };
        }
        return block;
    });
}

// ---------------------------------------------------------------------------
// 极简可观察 store（controller 同步驱动，React 经 useSyncExternalStore 消费）
// ---------------------------------------------------------------------------

export interface ChatStore {
    getState(): ChatState;
    dispatch(action: ChatAction): void;
    subscribe(listener: () => void): () => void;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
    switch (action.type) {
        case 'reset':
            return initialChatState(action.phase);
        case 'loadFailed':
            return { ...initialChatState('error'), loadError: action.error };
        case 'optimisticSend': {
            if (state.turns.some((turn) => turn.runId === action.runId)) return state;
            return {
                ...state,
                phase: 'ready',
                activeRunId: action.runId,
                turns: [...state.turns, { runId: action.runId, userText: action.text, blocks: [], status: 'streaming' }],
            };
        }
        case 'sendFailed': {
            const index = state.turns.findIndex((turn) => turn.runId === action.runId);
            if (index === -1) return state;
            return {
                ...touchTurn(state, index, (turn) => ({
                    ...turn,
                    status: 'error',
                    error: action.error,
                })),
                activeRunId: state.activeRunId === action.runId ? null : state.activeRunId,
            };
        }
        case 'resolveStaleRun': {
            // 断线后服务端已无该活跃 run 且无终态事件可期待（run 从未启动或日志丢失）
            const runId = state.activeRunId;
            if (runId === null) return state;
            const index = state.turns.findIndex((turn) => turn.runId === runId);
            const settled = index === -1 ? { ...state, activeRunId: null } : {
                ...touchTurn(state, index, (turn) => ({
                    ...turn,
                    status: 'error',
                    error: { message: '连接中断，本轮执行状态未知，请重试' },
                })),
                activeRunId: null,
            };
            // 问题已裁决 settled：并行重连循环的横幅一并复位，避免残留「正在重连」
            return settled.channel.state === 'reconnecting' ? { ...settled, channel: { state: 'ok' } } : settled;
        }
        case 'events':
            return applyEvents(state, action.batch);
        case 'channel': {
            // 值相等则不产生新引用（避免无意义的通知/渲染）
            if (action.channel.state === 'ok') {
                return state.channel.state === 'ok' ? state : { ...state, channel: action.channel };
            }
            const current = state.channel;
            if (current.state === 'reconnecting' && current.attempt === action.channel.attempt) return state;
            return { ...state, channel: action.channel };
        }
        default:
            return state;
    }
}

export function createChatStore(): ChatStore {
    let state = initialChatState('loading');
    const listeners = new Set<() => void>();
    return {
        getState: () => state,
        dispatch(action: ChatAction) {
            const next = chatReducer(state, action);
            if (next === state) return;
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
