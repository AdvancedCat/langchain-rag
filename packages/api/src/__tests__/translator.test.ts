import { describe, expect, it } from 'vitest';
import { translateRun, type ProtocolEventLike, type TranslatableRunStream } from '../agui/translator.js';

// fixture 形状以 scripts/probe-v3-stream.ts 的实测输出为准（2026-10-10）：
// messages channel = ChatModelStreamEvent，tools channel = tool-started/finished

function msg(ns: string, data: unknown): ProtocolEventLike {
    return { seq: 0, method: 'messages', params: { namespace: ns.split('/'), data } };
}
function tools(ns: string, data: unknown): ProtocolEventLike {
    return { seq: 0, method: 'tools', params: { namespace: ns.split('/'), data } };
}

function fakeRun(events: ProtocolEventLike[], finalMessages: unknown[]): TranslatableRunStream {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
        output: Promise.resolve({ messages: finalMessages }),
    };
}

/** 确定性投影：type + 关键字段（随机 id 如 TOOL_CALL_RESULT.messageId 不投影） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function project(e: any): string {
    switch (e.type) {
        case 'RUN_STARTED': return `RUN_STARTED|${e.threadId}|${e.runId}`;
        case 'RUN_FINISHED': return `RUN_FINISHED|${e.outcome?.type}`;
        case 'MESSAGES_SNAPSHOT': return `MESSAGES_SNAPSHOT|${e.messages.length}`;
        case 'TEXT_MESSAGE_START': return `TEXT_MESSAGE_START|${e.messageId}|${e.subagentRunId ?? ''}`;
        case 'TEXT_MESSAGE_CONTENT': return `TEXT_MESSAGE_CONTENT|${e.messageId}|${e.delta}`;
        case 'TEXT_MESSAGE_END': return `TEXT_MESSAGE_END|${e.messageId}`;
        case 'REASONING_MESSAGE_START': return `REASONING_MESSAGE_START|${e.messageId}`;
        case 'REASONING_MESSAGE_CONTENT': return `REASONING_MESSAGE_CONTENT|${e.messageId}|${e.delta}`;
        case 'REASONING_MESSAGE_END': return `REASONING_MESSAGE_END|${e.messageId}`;
        case 'TOOL_CALL_START': return `TOOL_CALL_START|${e.toolCallId}|${e.toolCallName}|${e.subagentRunId ?? ''}`;
        case 'TOOL_CALL_ARGS': return `TOOL_CALL_ARGS|${e.toolCallId}|${e.delta}`;
        case 'TOOL_CALL_END': return `TOOL_CALL_END|${e.toolCallId}`;
        case 'TOOL_CALL_RESULT': return `TOOL_CALL_RESULT|${e.toolCallId}|${e.content}`;
        case 'SUBAGENT_STARTED': return `SUBAGENT_STARTED|${e.subagentRunId}|${e.name}|${e.parentToolCallId}`;
        case 'SUBAGENT_FINISHED': return `SUBAGENT_FINISHED|${e.subagentRunId}|${e.result}`;
        default: return String(e.type);
    }
}

async function collect(run: TranslatableRunStream): Promise<string[]> {
    const out: string[] = [];
    for await (const event of translateRun(run, { threadId: 't1', runId: 'r1' })) {
        out.push(project(event));
    }
    return out;
}

describe('translateRun golden 序列', () => {
    it('主代理 reasoning+text+流式工具调用、工具结果、子代理委派、快照与收尾的完整映射', async () => {
        const events: ProtocolEventLike[] = [
            // 主代理一轮模型输出（ns 深度 1，model_request:*）
            msg('model_request:A', { event: 'message-start', id: 'm1' }),
            msg('model_request:A', { event: 'content-block-delta', index: 0, delta: { type: 'reasoning-delta', reasoning: '先想一下' } }),
            msg('model_request:A', { event: 'content-block-delta', index: 1, delta: { type: 'text-delta', text: '我来查' } }),
            msg('model_request:A', { event: 'content-block-delta', index: 1, delta: { type: 'text-delta', text: '一下' } }),
            msg('model_request:A', { event: 'content-block-start', index: 2, content: { type: 'tool_call_chunk', id: 'c1', name: 'search_documentation', args: '' } }),
            msg('model_request:A', { event: 'content-block-delta', index: 2, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c1', name: 'search_documentation', args: '{"query":"什么是' } } }),
            msg('model_request:A', { event: 'content-block-delta', index: 2, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c1', args: 'langchain"}' } } }),
            msg('model_request:A', { event: 'content-block-finish', index: 2, content: { type: 'tool_call_chunk', id: 'c1' } }),
            msg('model_request:A', { event: 'message-finish' }),

            // search_documentation 执行完成（tools channel，非 task；finished 无 tool_name，name 在 output）
            tools('tools:X', { event: 'tool-finished', tool_call_id: 'c1', output: { content: 'Saved 4 documentation chunks', name: 'search_documentation' } }),

            // 工具内部 LLM（query rewrite，ns 深度 1 tools:X）——不映射
            msg('tools:X', { event: 'message-start', id: 'rewrite-1' }),
            msg('tools:X', { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: 'rewrite 输出不应出现' } }),
            msg('tools:X', { event: 'message-finish' }),

            // 子代理委派（task）
            tools('tools:S1', {
                event: 'tool-started',
                tool_call_id: 'c2',
                tool_name: 'task',
                input: '{"description":"read chunk 1","subagent_type":"chunk-analyst"}',
            }),
            // 子代理自己的模型输出（ns 深度 2 → 带 subagentRunId）
            msg('tools:S1/model_request:B', { event: 'message-start', id: 'm2' }),
            msg('tools:S1/model_request:B', { event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: '分析结果' } }),
            msg('tools:S1/model_request:B', { event: 'content-block-start', index: 1, content: { type: 'tool_call_chunk', id: 'c3', name: 'read_file', args: '' } }),
            msg('tools:S1/model_request:B', { event: 'content-block-finish', index: 1, content: { type: 'tool_call_chunk', id: 'c3' } }),
            msg('tools:S1/model_request:B', { event: 'message-finish' }),
            tools('tools:S1', {
                event: 'tool-finished',
                tool_call_id: 'c2',
                // task 的真实输出形态：LangGraph Command，ToolMessage 在 update.messages 末条
                output: { lg_name: 'Command', update: { messages: [{ content: 'analyst report', name: 'task' }] }, goto: [] },
            }),
        ];

        const finalMessages = [
            { id: 'u0', getType: () => 'human', content: '什么是langchain' },
            { id: 'm1', getType: () => 'ai', content: '我来查一下' },
            { id: 't0', getType: () => 'tool', content: 'Saved 4 documentation chunks', tool_call_id: 'c1' },
        ];

        expect(await collect(fakeRun(events, finalMessages))).toEqual([
            'RUN_STARTED|t1|r1',
            'REASONING_MESSAGE_START|m1',
            'REASONING_MESSAGE_CONTENT|m1|先想一下',
            'TEXT_MESSAGE_START|m1|',
            'TEXT_MESSAGE_CONTENT|m1|我来查',
            'TEXT_MESSAGE_CONTENT|m1|一下',
            'TOOL_CALL_START|c1|search_documentation|',
            'TOOL_CALL_ARGS|c1|{"query":"什么是',
            'TOOL_CALL_ARGS|c1|langchain"}',
            'TOOL_CALL_END|c1',
            'TEXT_MESSAGE_END|m1',
            'REASONING_MESSAGE_END|m1',
            'TOOL_CALL_RESULT|c1|Saved 4 documentation chunks',
            'SUBAGENT_STARTED|S1|chunk-analyst|c2',
            'TEXT_MESSAGE_START|m2|S1',
            'TEXT_MESSAGE_CONTENT|m2|分析结果',
            'TOOL_CALL_START|c3|read_file|S1',
            'TOOL_CALL_END|c3',
            'TEXT_MESSAGE_END|m2',
            'SUBAGENT_FINISHED|S1|analyst report',
            'TOOL_CALL_RESULT|c2|analyst report',
            'MESSAGES_SNAPSHOT|3',
            'RUN_FINISHED|success',
        ]);
    });

    it('兜底：provider 未发 content-block-start 首帧时，block-delta 内的 id/name 补发 TOOL_CALL_START', async () => {
        const events = [
            msg('model_request:A', { event: 'message-start', id: 'm1' }),
            msg('model_request:A', { event: 'content-block-delta', index: 0, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c9', name: 'write_todos', args: '{"todos":' } } }),
            msg('model_request:A', { event: 'message-finish' }),
        ];
        expect(await collect(fakeRun(events, []))).toEqual([
            'RUN_STARTED|t1|r1',
            'TOOL_CALL_START|c9|write_todos|',
            'TOOL_CALL_ARGS|c9|{"todos":',
            'MESSAGES_SNAPSHOT|0',
            'RUN_FINISHED|success',
        ]);
    });

    it('终态消息映射：human/ai/tool → user/assistant/tool，content 块数组拼接文本', async () => {
        const finalMessages = [
            { id: 'u0', getType: () => 'human', content: 'q' },
            { id: 'a1', getType: () => 'ai', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
        ];
        const events: ProtocolEventLike[] = [];
        const out: Array<Record<string, unknown>> = [];
        for await (const event of translateRun(fakeRun(events, finalMessages), { threadId: 't', runId: 'r' })) {
            out.push(event as unknown as Record<string, unknown>);
        }
        const snapshot = out.find((e) => e.type === 'MESSAGES_SNAPSHOT') as { messages: Array<{ id: string; role: string; content: string }> };
        expect(snapshot.messages).toEqual([
            { id: 'u0', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'hello world' },
        ]);
    });

    it('快照式 tool_call_chunk.args（deepseek 实测形态）归一为增量 delta', async () => {
        // 每帧 args 为「到当前为止的完整快照」（2026-10-10 联调抓帧实测）
        const snapshots = ['{', '{"q', '{"query', '{"query":', '{"query": "LangGraph"}'];
        const events = [
            msg('model_request:A', { event: 'message-start', id: 'm1' }),
            ...snapshots.map((args) =>
                msg('model_request:A', {
                    event: 'content-block-delta',
                    index: 0,
                    delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c1', name: 'search_documentation', args } },
                }),
            ),
            msg('model_request:A', { event: 'message-finish' }),
        ];
        const out = await collect(fakeRun(events, []));
        // 每帧只发射新增后缀；增量式 provider 的输入不受影响（不满足前缀时原样透传）
        expect(out).toEqual([
            'RUN_STARTED|t1|r1',
            'TOOL_CALL_START|c1|search_documentation|',
            'TOOL_CALL_ARGS|c1|{',
            'TOOL_CALL_ARGS|c1|"q',
            'TOOL_CALL_ARGS|c1|uery',
            'TOOL_CALL_ARGS|c1|":',
            'TOOL_CALL_ARGS|c1| "LangGraph"}',
            'MESSAGES_SNAPSHOT|0',
            'RUN_FINISHED|success',
        ]);
    });

    it('快照式 args：乱序/非前缀 chunk 原样透传（不误伤增量式 provider）', async () => {
        const events = [
            msg('model_request:A', { event: 'message-start', id: 'm1' }),
            msg('model_request:A', { event: 'content-block-delta', index: 0, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c1', name: 't', args: '{"a":1,' } } }),
            // 不以已发射内容为前缀 → 真增量，原样透传
            msg('model_request:A', { event: 'content-block-delta', index: 0, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'c1', args: '"b":2}' } } }),
            msg('model_request:A', { event: 'message-finish' }),
        ];
        expect(await collect(fakeRun(events, []))).toEqual([
            'RUN_STARTED|t1|r1',
            'TOOL_CALL_START|c1|t|',
            'TOOL_CALL_ARGS|c1|{"a":1,',
            'TOOL_CALL_ARGS|c1|"b":2}',
            'MESSAGES_SNAPSHOT|0',
            'RUN_FINISHED|success',
        ]);
    });
});
