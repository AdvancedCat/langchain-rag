// ============================================================================
// 子代理（task 工具）span 中间件：span 命名、input/output、非 task 直通、
// 禁用直通、report 提取（ToolMessage 与 Command 两种形态）（方案 §3.3）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';

const mocks = vi.hoisted(() => {
    const makeFakeSpan = () => {
        const attributes: Record<string, unknown> = {};
        return {
            attributes,
            setAttribute(key: string, value: unknown) {
                attributes[key] = value;
            },
            end: vi.fn(),
        };
    };
    return { makeFakeSpan };
});

vi.mock('@cozeloop/ai', () => ({
    cozeLoopTracer: {
        initialize: vi.fn(),
        forceFlush: vi.fn(),
        shutdown: vi.fn(),
        // 模拟 SDK traceable：执行 fn 并传入 span（真实实现会 startActiveSpan 建
        // 立异步上下文，span 生命周期由 SDK 管理，这里不 end）
        traceable: vi.fn((fn: (span: unknown) => unknown) => fn(mocks.makeFakeSpan())),
        getTracer: () => ({ startSpan: vi.fn() }),
        setInput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_input', value),
        setOutput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_output', value),
        setError: (span: ReturnType<typeof mocks.makeFakeSpan>, msg?: string) =>
            span.setAttribute('error', msg ?? 'unknown'),
    },
    SpanKind: { Tool: 'tool' },
    COZELOOP_TRACE_BASIC_TAGS: {
        SPAN_NAME: 'cozeloop_span_name',
        SPAN_TYPE: 'cozeloop_span_type',
    },
    COZELOOP_TRACE_BUSINESS_TAGS: {},
}));

vi.mock('../cozeloop.js', () => ({
    isCozeLoopEnabled: vi.fn(() => true),
}));

import { cozeLoopTracer } from '@cozeloop/ai';
import { isCozeLoopEnabled } from '../cozeloop.js';
import { createSubagentSpanMiddleware } from '../subagent-span.js';

function makeRequest(toolCall: { name: string; args?: unknown }): unknown {
    return { toolCall: { ...toolCall, id: 'call-1', type: 'tool_call' }, tool: undefined, state: {}, runtime: {} };
}

function toolMessage(content: unknown): ToolMessage {
    return new ToolMessage({ content: content as never, tool_call_id: 'call-1', name: 'task' });
}

beforeEach(() => {
    vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
    vi.mocked(cozeLoopTracer.traceable).mockClear();
});

describe('createSubagentSpanMiddleware', () => {
    it('task 工具：建 `task.<subagent_type>` tool span，input 记 subagent_type/description，结果透传', async () => {
        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>;
        const handler = vi.fn(async () => toolMessage('analyst final report'));

        const result = await wrap(
            makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst', description: 'analyze chunk 1' } }),
            handler,
        );

        expect(handler).toHaveBeenCalledTimes(1);
        expect(result).toBe(await handler.mock.results[0].value);
        expect(cozeLoopTracer.traceable).toHaveBeenCalledTimes(1);
        const options = vi.mocked(cozeLoopTracer.traceable).mock.calls[0][1] as unknown as Record<string, unknown>;
        expect(options).toMatchObject({ name: 'task.chunk-analyst', type: 'tool', recordInputs: false, recordOutputs: false });
    });

    it('task 工具：input/output 写入 fake span（经 mock 的 setInput/setOutput 通道验证）', async () => {
        const seen: Array<Record<string, unknown>> = [];
        vi.mocked(cozeLoopTracer.traceable).mockImplementation(((fn: (span: Record<string, unknown>) => unknown) => {
            const span = mocks.makeFakeSpan();
            seen.push(span.attributes);
            return fn(span);
        }) as never);

        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>;
        await wrap(
            makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst', description: 'analyze' } }),
            async () => toolMessage('report text'),
        );

        expect(seen[0]['cozeloop_span_input']).toEqual({
            subagent_type: 'chunk-analyst',
            description: 'analyze',
        });
        expect(seen[0]['cozeloop_span_output']).toEqual({ report: 'report text' });
    });

    it('非 task 工具直通：不触碰 SDK', async () => {
        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>;
        const handler = vi.fn(async () => toolMessage('search done'));
        const result = await wrap(makeRequest({ name: 'search_documentation', args: { query: 'q' } }), handler);
        expect(result).toBe(await handler.mock.results[0].value);
        expect(cozeLoopTracer.traceable).not.toHaveBeenCalled();
    });

    it('禁用时直通：fn(null) 路径，不触碰 SDK', async () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(false);
        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>;
        const handler = vi.fn(async () => toolMessage('done'));
        const result = await wrap(
            makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst' } }),
            handler,
        );
        expect(result).toBe(await handler.mock.results[0].value);
        expect(cozeLoopTracer.traceable).not.toHaveBeenCalled();
    });

    it('report 提取：数组 content 取 text block 拼接；Command 形态取 update.messages 最后一条', async () => {
        const seen: Array<Record<string, unknown>> = [];
        vi.mocked(cozeLoopTracer.traceable).mockImplementation(((fn: (span: Record<string, unknown>) => unknown) => {
            const span = mocks.makeFakeSpan();
            seen.push(span.attributes);
            return fn(span);
        }) as never);
        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<unknown>,
        ) => Promise<unknown>;

        await wrap(
            makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst' } }),
            async () => toolMessage([{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }]),
        );
        expect(seen[0]['cozeloop_span_output']).toEqual({ report: 'block one\nblock two' });

        // deepagents 正常路径返回 Command（update.messages 携带 ToolMessage）
        await wrap(
            makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst' } }),
            async () => ({ update: { messages: [toolMessage('Task completed')] } }),
        );
        expect(seen[1]['cozeloop_span_output']).toEqual({ report: 'Task completed' });
    });

    it('handler 抛错：异常原样透传（span 错误路径由 SDK traceable 负责）', async () => {
        const middleware = createSubagentSpanMiddleware();
        const wrap = middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (req: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>;
        await expect(
            wrap(
                makeRequest({ name: 'task', args: { subagent_type: 'chunk-analyst' } }),
                async () => {
                    throw new Error('subagent crashed');
                },
            ),
        ).rejects.toThrow('subagent crashed');
    });
});
