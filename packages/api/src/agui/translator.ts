// ============================================================================
// AgUiTranslator：deepagents streamEvents(v3) 的 ProtocolEvent 有序流 → AG-UI 事件
//
// 事件源与归属规则（2026-10-10 用 scripts/probe-v3-stream.ts 实测标定，
// 对应方案 docs/api-service-plan.md §6 与 §12 风险 1 的验证结论）：
//
//   ProtocolEvent（单一全局有序流，seq 递增）
//   ├─ method=messages（data = ChatModelStreamEvent）
//   │   ├─ ns 深度 1 且 model_request:*  → 主代理消息（TEXT/REASONING/TOOL_CALL 流）
//   │   ├─ ns 深度 ≥2 且 tools:X/model_request:Y → 子代理消息（带 subagentRunId=X）
//   │   └─ ns 深度 1 且 tools:X          → 工具内部 LLM（query rewrite），
//   │                                      P1 不映射（P3 归入 retrieval.trace CUSTOM）
//   ├─ method=tools（data = {event, tool_call_id, tool_name, input|output}）
//   │   ├─ tool_name=task 的 tool-started  → SubagentStarted（name=input.subagent_type）
//   │   ├─ tool-finished（task）           → SubagentFinished + TOOL_CALL_RESULT
//   │   └─ tool-finished（其他）           → TOOL_CALL_RESULT
//   └─ 其余 channel（tasks/lifecycle/values/checkpoints/updates）→ 忽略
//
// TOOL_CALL_START/ARGS/END 取自模型侧 tool_call_chunk（args 流式、含子代理
// read_file），TOOL_CALL_RESULT 取自执行侧 tool-finished，以 toolCallId 关联。
// TEXT/REASONING 的 START 懒发送（首个 delta 到达才发），message-finish 收口。
// ============================================================================

import { randomUUID } from 'node:crypto';
import { EventType, type Event as AguiEvent, type Message } from '@ag-ui/core';

// ---------------------------------------------------------------------------
// 结构化最小类型：只依赖 deepagents v3 流中 translator 消费的面，
// 不直接 import langgraph 内部类型（单测可伪造、上游升级不殃及本层）
// ---------------------------------------------------------------------------

export interface ProtocolEventLike {
    readonly seq: number;
    readonly method: string;
    readonly params: {
        readonly namespace: readonly string[];
        readonly node?: string;
        readonly data: unknown;
    };
}

export interface TranslatableRunStream extends AsyncIterable<ProtocolEventLike> {
    /** run 终态 state（messages 为 LangChain 消息对象数组） */
    readonly output: PromiseLike<{ messages: unknown[] }>;
}

export interface TranslateContext {
    threadId: string;
    runId: string;
}

/** ChatModelStreamEvent（@langchain/core）中 translator 关心的形状 */
interface MessageEventLike {
    event: string;
    id?: string;
    index?: number;
    content?: { type: string; id?: string; name?: string; args?: string };
    delta?: {
        type: string;
        text?: string;
        reasoning?: string;
        fields?: { type: string; id?: string; name?: string; args?: string };
    };
}

/** tools channel payload（probe 实测形状：finished 无 tool_name；
 *  普通工具 output 为 ToolMessage（content/name 直接挂载），
 *  task/子代理委派 output 为 LangGraph Command（内容在 update.messages 末条 ToolMessage）） */
interface ToolsEventLike {
    event: 'tool-started' | 'tool-finished';
    tool_call_id: string;
    tool_name?: string;
    input?: string;
    output?: {
        content?: unknown;
        name?: string;
        lg_name?: string;
        update?: { messages?: unknown[] };
    };
}

interface ActiveMessage {
    messageId: string;
    subagentRunId?: string;
    textStarted: boolean;
    reasoningStarted: boolean;
}

interface TranslatorState {
    /** nsKey → 活跃消息 */
    messages: Map<string, ActiveMessage>;
    /** 已发过 TOOL_CALL_START 的 toolCallId */
    toolCallsStarted: Set<string>;
    /** tool-started 时登记的 task（子代理委派）调用，finished 判定用 */
    taskToolCalls: Set<string>;
}

const now = () => Date.now();

/** ns → 子代理归属：`tools:X/model_request:Y` 返回 X；主代理/工具内部返回 undefined */
function subagentRunIdOf(namespace: readonly string[]): string | undefined {
    if (namespace.length >= 2 && namespace[0]?.startsWith('tools:')) {
        return namespace[0].slice('tools:'.length);
    }
    return undefined;
}

/** 深度 1 的 tools:X 是工具内部 LLM 调用（query rewrite），不映射进对话流 */
function shouldMapMessages(namespace: readonly string[]): boolean {
    return !(namespace.length === 1 && namespace[0]?.startsWith('tools:'));
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part) {
                    return String((part as { text?: unknown }).text ?? '');
                }
                return '';
            })
            .join('');
    }
    return '';
}

/** LangChain 终态消息 → AG-UI Message（duck-typing，避免依赖 LC 消息类；
 *  Message 是按 role 判别的联合，需逐字面量构造） */
function toAguiMessage(lcMessage: unknown): Message {
    const msg = lcMessage as {
        id?: string;
        getType?: () => string;
        content?: unknown;
        tool_call_id?: string;
    };
    const lcType = msg.getType?.() ?? (msg.tool_call_id !== undefined ? 'tool' : 'ai');
    const id = msg.id ?? randomUUID();
    const content = extractText(msg.content);
    switch (lcType) {
        case 'human':
            return { id, role: 'user', content };
        case 'system':
            return { id, role: 'system', content };
        case 'tool':
            return { id, role: 'tool', content, toolCallId: msg.tool_call_id ?? id };
        default:
            return { id, role: 'assistant', content };
    }
}

export async function* translateRun(
    run: TranslatableRunStream,
    ctx: TranslateContext,
): AsyncGenerator<AguiEvent> {
    const { threadId, runId } = ctx;

    yield { type: EventType.RUN_STARTED, threadId, runId, timestamp: now() };

    const state: TranslatorState = { messages: new Map(), toolCallsStarted: new Set(), taskToolCalls: new Set() };

    for await (const ev of run) {
        if (ev.method === 'messages' && shouldMapMessages(ev.params.namespace)) {
            yield* translateMessageEvent(
                ev.params.namespace.join('/'),
                ev.params.data as MessageEventLike,
                state,
            );
        } else if (ev.method === 'tools') {
            yield* translateToolsEvent(ev.params.data as ToolsEventLike, ev.params.namespace, state);
        }
        // tasks/lifecycle/values/checkpoints/updates：不映射
    }

    const output = await run.output;
    yield {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: output.messages.map(toAguiMessage),
        timestamp: now(),
    };
    yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: 'success' },
        timestamp: now(),
    };
}

function* translateMessageEvent(
    nsKey: string,
    data: MessageEventLike,
    state: TranslatorState,
): Generator<AguiEvent> {
    if (data.event === 'message-start') {
        state.messages.set(nsKey, {
            messageId: data.id ?? randomUUID(),
            subagentRunId: subagentRunIdOf(nsKey.split('/')),
            textStarted: false,
            reasoningStarted: false,
        });
        return;
    }

    const active = state.messages.get(nsKey);
    if (!active) return;

    switch (data.event) {
        case 'content-block-start': {
            // tool_call_chunk 首帧带 id/name（args 为空串）→ TOOL_CALL_START
            const content = data.content;
            if (content?.type === 'tool_call_chunk' && content.id) {
                yield* toolCallStart(
                    content.id,
                    content.name ?? 'unknown',
                    active,
                    state,
                );
            }
            // text/reasoning 块的 START 懒发送到首个 delta
            return;
        }
        case 'content-block-delta': {
            const delta = data.delta;
            if (!delta) return;

            if (delta.type === 'text-delta' && delta.text) {
                if (!active.textStarted) {
                    active.textStarted = true;
                    yield {
                        type: EventType.TEXT_MESSAGE_START,
                        messageId: active.messageId,
                        role: 'assistant',
                        subagentRunId: active.subagentRunId,
                        timestamp: now(),
                    };
                }
                yield {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: active.messageId,
                    delta: delta.text,
                    subagentRunId: active.subagentRunId,
                    timestamp: now(),
                };
            } else if (delta.type === 'reasoning-delta' && delta.reasoning) {
                if (!active.reasoningStarted) {
                    active.reasoningStarted = true;
                    yield {
                        type: EventType.REASONING_MESSAGE_START,
                        messageId: active.messageId,
                        role: 'reasoning',
                        subagentRunId: active.subagentRunId,
                        timestamp: now(),
                    };
                }
                yield {
                    type: EventType.REASONING_MESSAGE_CONTENT,
                    messageId: active.messageId,
                    delta: delta.reasoning,
                    subagentRunId: active.subagentRunId,
                    timestamp: now(),
                };
            } else if (delta.type === 'block-delta' && delta.fields?.type === 'tool_call_chunk') {
                // 兜底：provider 未发 content-block-start 首帧时在此补 START
                if (delta.fields.id) {
                    yield* toolCallStart(
                        delta.fields.id,
                        delta.fields.name ?? 'unknown',
                        active,
                        state,
                    );
                }
                if (delta.fields.args) {
                    yield {
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: delta.fields.id ?? active.messageId,
                        delta: delta.fields.args,
                        subagentRunId: active.subagentRunId,
                        timestamp: now(),
                    };
                }
            }
            return;
        }
        case 'content-block-finish': {
            if (data.content?.type === 'tool_call_chunk' && data.content.id) {
                yield {
                    type: EventType.TOOL_CALL_END,
                    toolCallId: data.content.id,
                    subagentRunId: active.subagentRunId,
                    timestamp: now(),
                };
            }
            return;
        }
        case 'message-finish': {
            if (active.textStarted) {
                yield {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: active.messageId,
                    subagentRunId: active.subagentRunId,
                    timestamp: now(),
                };
            }
            if (active.reasoningStarted) {
                yield {
                    type: EventType.REASONING_MESSAGE_END,
                    messageId: active.messageId,
                    subagentRunId: active.subagentRunId,
                    timestamp: now(),
                };
            }
            state.messages.delete(nsKey);
            return;
        }
        default:
            return;
    }
}

function* toolCallStart(
    toolCallId: string,
    toolCallName: string,
    active: ActiveMessage,
    state: TranslatorState,
): Generator<AguiEvent> {
    if (state.toolCallsStarted.has(toolCallId)) return;
    state.toolCallsStarted.add(toolCallId);
    yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName,
        parentMessageId: active.messageId,
        subagentRunId: active.subagentRunId,
        timestamp: now(),
    };
}

function* translateToolsEvent(
    data: ToolsEventLike,
    namespace: readonly string[],
    state: TranslatorState,
): Generator<AguiEvent> {
    if (data.event === 'tool-started') {
        // task 即子代理委派（deepagents）：ns=tools:<uuid> 的 uuid 即 subagentRunId，
        // 与子代理消息 ns（tools:<uuid>/model_request:*）对齐
        if (data.tool_name === 'task' && namespace[0]?.startsWith('tools:')) {
            state.taskToolCalls.add(data.tool_call_id);
            let subagentType = 'task';
            try {
                const parsed = JSON.parse(data.input ?? '{}') as { subagent_type?: string };
                if (parsed.subagent_type) subagentType = parsed.subagent_type;
            } catch {
                // input 非法时回退通用名
            }
            yield {
                type: EventType.SUBAGENT_STARTED,
                subagentRunId: namespace[0].slice('tools:'.length),
                name: subagentType,
                parentToolCallId: data.tool_call_id,
                timestamp: now(),
            };
        }
        return;
    }

    // tool-finished → TOOL_CALL_RESULT（task 先发 SubagentFinished）
    const { content, name } = extractToolResult(data.output);
    const isTask = state.taskToolCalls.has(data.tool_call_id) || name === 'task';
    if (isTask && namespace[0]?.startsWith('tools:')) {
        yield {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: namespace[0].slice('tools:'.length),
            result: content,
            outcome: { type: 'success' },
            timestamp: now(),
        };
    }
    yield {
        type: EventType.TOOL_CALL_RESULT,
        messageId: randomUUID(),
        toolCallId: data.tool_call_id,
        content,
        role: 'tool',
        timestamp: now(),
    };
}

/** 工具输出提取：普通工具为 ToolMessage；task/子代理委派为 Command（update.messages 末条） */
function extractToolResult(output: ToolsEventLike['output']): { content: string; name?: string } {
    if (!output) return { content: '' };
    if (output.update?.messages?.length) {
        const last = output.update.messages.at(-1) as { content?: unknown; name?: string } | undefined;
        return { content: extractText(last?.content), name: last?.name };
    }
    return { content: extractText(output.content), name: output.name };
}
