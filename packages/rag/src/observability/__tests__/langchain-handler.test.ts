// ============================================================================
// LangChain 回调 handler：LLM span 生命周期、token/TTFT 业务标签、run_id 幂等、
// 错误路径、禁用直通（方案 §3.4）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMResult } from '@langchain/core/outputs';

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
    const startSpan = vi.fn((_name: string, options?: { attributes?: Record<string, unknown> }) => {
        const span = makeFakeSpan();
        for (const [key, value] of Object.entries(options?.attributes ?? {})) {
            span.setAttribute(key, value);
        }
        return span;
    });
    const fakeParentContext = { marker: 'parent-context' };
    return { makeFakeSpan, startSpan, fakeParentContext };
});

vi.mock('@cozeloop/ai', () => ({
    cozeLoopTracer: {
        initialize: vi.fn(),
        forceFlush: vi.fn(),
        shutdown: vi.fn(),
        traceable: vi.fn(),
        getTracer: () => ({ startSpan: mocks.startSpan }),
        setInput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_input', value),
        setOutput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_output', value),
        setError: (span: ReturnType<typeof mocks.makeFakeSpan>, msg?: string) =>
            span.setAttribute('error', msg ?? 'unknown'),
    },
    SpanKind: {
        PromptHub: 'prompt_hub',
        PromptTemplate: 'prompt',
        Model: 'model',
        Retriever: 'retriever',
        Tool: 'tool',
    },
    COZELOOP_TRACE_BASIC_TAGS: {
        SPAN_NAME: 'cozeloop_span_name',
        SPAN_TYPE: 'cozeloop_span_type',
        SPAN_INPUT: 'cozeloop_span_input',
        SPAN_OUTPUT: 'cozeloop_span_output',
    },
    COZELOOP_TRACE_BUSINESS_TAGS: {
        ERROR_MESSAGE: 'error',
        START_TIME_FIRST_RESP: 'start_time_first_resp',
        MODEL_NAME: 'model_name',
        MODEL_PROVIDER: 'model_provider',
        INPUT_TOKENS: 'input_tokens',
        OUTPUT_TOKENS: 'output_tokens',
        TOKENS: 'tokens',
        STREAM: 'stream',
        RETRIEVER_PROVIDER: 'retriever_provider',
    },
    context: { active: () => mocks.fakeParentContext },
}));

vi.mock('../cozeloop.js', () => ({
    isCozeLoopEnabled: vi.fn(() => true),
}));

import { isCozeLoopEnabled } from '../cozeloop.js';
import { COZELOOP_PARENT_CONTEXT_METADATA } from '../spans.js';
import { CozeLoopLangChainCallbackHandler, getLangChainTracingCallbacks } from '../langchain-handler.js';

/** 造一个假 LLMResult（DeepSeek/OpenAI 兼容形态） */
function llmResult(overrides: Partial<Record<'generations' | 'llmOutput', unknown>> = {}): LLMResult {
    return {
        generations: [[{ text: 'the answer', generationInfo: {}, type: 'generation' }]],
        llmOutput: {
            token_usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
            model_name: 'deepseek-v4-flash',
        },
        ...overrides,
    } as unknown as LLMResult;
}

beforeEach(() => {
    vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
    mocks.startSpan.mockClear();
});

describe('CozeLoopLangChainCallbackHandler', () => {
    it('handleLLMStart 创建 model span，input 为截断后的用户消息', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({ id: ['chatopenai'], kwargs: {} } as never, ['Q1', 'Q2'], 'run-1', 'parent-1', undefined, undefined, undefined, 'ChatOpenAI');
        expect(mocks.startSpan).toHaveBeenCalledWith('ChatOpenAI.model', expect.anything());
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        expect(span.attributes['cozeloop_span_type']).toBe('model');
        expect(span.attributes['cozeloop_span_input']).toEqual({
            messages: [{ role: 'user', content: 'Q1\n\nQ2' }],
        });
    });

    it('metadata 携带显式父 context 时透传给 tracer 三参 startSpan（并行 tool 下 rewrite/multiQuery 层级修正）', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart(
            {} as never,
            ['q'],
            'run-meta',
            undefined,
            undefined,
            undefined,
            { [COZELOOP_PARENT_CONTEXT_METADATA]: mocks.fakeParentContext },
            'llm',
        );
        expect(mocks.startSpan).toHaveBeenCalledWith(
            'llm.model',
            expect.anything(),
            mocks.fakeParentContext,
        );
    });

    it('metadata 未携带父 context 时保持二参调用（父级 = ambient，主模型/子代理路径不受影响）', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-ambient', undefined, undefined, undefined, { other: 1 });
        expect(mocks.startSpan).toHaveBeenCalledTimes(1);
        expect(mocks.startSpan.mock.calls[0]).toHaveLength(2);
    });

    it('超长 prompt 截断（不带全文进 span）', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        const longPrompt = 'x'.repeat(5000);
        handler.handleLLMStart({} as never, [longPrompt], 'run-long');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        const input = span.attributes['cozeloop_span_input'] as { messages: Array<{ content: string }> };
        expect(input.messages[0].content.length).toBeLessThan(2500);
        expect(input.messages[0].content).toMatch(/\[truncated/);
    });

    it('同一 run_id 重复 Start 幂等（实例级 + config 级双注册场景）', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-dup', undefined, undefined, undefined, undefined, 'llm');
        handler.handleLLMStart({} as never, ['q'], 'run-dup', undefined, undefined, undefined, undefined, 'llm');
        expect(mocks.startSpan).toHaveBeenCalledTimes(1);
    });

    it('handleLLMEnd 写 output/业务标签并 end span', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-2', undefined, undefined, undefined, undefined, 'ChatOpenAI');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult(), 'run-2');
        expect(span.attributes['cozeloop_span_output']).toEqual({
            choices: [{ message: { role: 'assistant', content: 'the answer' } }],
        });
        expect(span.attributes['model_name']).toBe('deepseek-v4-flash');
        expect(span.attributes['model_provider']).toBe('deepseek');
        expect(span.attributes['input_tokens']).toBe(120);
        expect(span.attributes['output_tokens']).toBe(45);
        expect(span.attributes['tokens']).toBe(165);
        expect(span.attributes['stream']).toBeUndefined();
        expect(span.end).toHaveBeenCalledTimes(1);
        // span 已出队：重复 End 无副作用
        handler.handleLLMEnd(llmResult(), 'run-2');
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('流式输出：首 token 记 START_TIME_FIRST_RESP 并打 STREAM 标签', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-3');
        handler.handleLLMNewToken('a', {} as never, 'run-3');
        handler.handleLLMNewToken('b', {} as never, 'run-3');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult(), 'run-3');
        expect(span.attributes['start_time_first_resp']).toBeGreaterThan(0);
        expect(span.attributes['stream']).toBe(true);
    });

    it('llmOutput 缺失时不写 token 标签，model_name 回退 LLM_MODEL env', () => {
        process.env.LLM_MODEL = 'deepseek-v4-flash';
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-4');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({ llmOutput: undefined }), 'run-4');
        expect(span.attributes['model_name']).toBe('deepseek-v4-flash');
        expect(span.attributes['input_tokens']).toBeUndefined();
        expect(span.attributes['tokens']).toBeUndefined();
    });

    it('流式路径 llmOutput 无 model_name 时，取 Start 提取的序列化 kwargs.model（修 unknown）', () => {
        delete process.env.LLM_MODEL;
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({ kwargs: { model: 'deepseek-v4-flash' } } as never, ['q'], 'run-5');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({ llmOutput: undefined }), 'run-5');
        expect(span.attributes['model_name']).toBe('deepseek-v4-flash');
    });

    it('model_name 优先级：配置的 kwargs.model > llmOutput.model_name > env', () => {
        process.env.LLM_MODEL = 'env-model';
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart(
            { kwargs: { model: 'configured-model' } } as never,
            ['q'],
            'run-6',
        );
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({ llmOutput: { token_usage: {}, model_name: 'served-model' } }), 'run-6');
        expect(span.attributes['model_name']).toBe('configured-model');
    });

    it('kwargs 用 model_name 键时同样可提取；Error 路径清理 model 缓存', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({ kwargs: { model_name: 'deepseek-reasoner' } } as never, ['q'], 'run-7');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMError(new Error('x'), 'run-7');
        expect(span.attributes['error']).toBe('x');
        // 缓存已清理：重复 Error 无副作用
        expect(() => handler.handleLLMError(new Error('x'), 'run-7')).not.toThrow();
    });

    it('流式真实形态：token 用量取 generation.message.usage_metadata（1.x 标准来源）', () => {
        delete process.env.LLM_MODEL;
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-8');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({
            generations: [[{
                text: 'ok',
                generationInfo: {},
                message: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
            }]],
            llmOutput: undefined,
        }), 'run-8');
        expect(span.attributes['input_tokens']).toBe(10);
        expect(span.attributes['output_tokens']).toBe(5);
        expect(span.attributes['tokens']).toBe(15);
    });

    it('token 用量回退 llmOutput.tokenUsage（core _streamIterator 的 camelCase 形态）', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-9');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({
            llmOutput: { tokenUsage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
        }), 'run-9');
        expect(span.attributes['input_tokens']).toBe(7);
        expect(span.attributes['output_tokens']).toBe(3);
        expect(span.attributes['tokens']).toBe(10);
    });

    it('model_name 兜底服务端回显 response_metadata.model_name（kwargs 与 env 均缺失时）', () => {
        delete process.env.LLM_MODEL;
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-10');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMEnd(llmResult({
            generations: [[{
                text: 'ok',
                generationInfo: {},
                message: { response_metadata: { model_name: 'deepseek-v4-flash' } },
            }]],
            llmOutput: undefined,
        }), 'run-10');
        expect(span.attributes['model_name']).toBe('deepseek-v4-flash');
    });

    it('handleLLMError：setError + end', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-err');
        const span = mocks.startSpan.mock.results[0].value as ReturnType<typeof mocks.makeFakeSpan>;
        handler.handleLLMError(new Error('provider 500'), 'run-err');
        expect(span.attributes['error']).toBe('provider 500');
        expect(span.end).toHaveBeenCalledTimes(1);
    });

    it('未知 run 的 End/Error（如 Start 时未启用）安全 no-op', () => {
        const handler = new CozeLoopLangChainCallbackHandler();
        expect(() => {
            handler.handleLLMEnd(llmResult(), 'never-started');
            handler.handleLLMError(new Error('x'), 'never-started');
        }).not.toThrow();
    });

    it('禁用状态下 handleLLMStart 不建 span', () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(false);
        const handler = new CozeLoopLangChainCallbackHandler();
        handler.handleLLMStart({} as never, ['q'], 'run-off');
        expect(mocks.startSpan).not.toHaveBeenCalled();
    });
});

describe('getLangChainTracingCallbacks', () => {
    it('禁用时返回空数组；启用时返回单例 handler', () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(false);
        expect(getLangChainTracingCallbacks()).toEqual([]);
        vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
        const a = getLangChainTracingCallbacks() as unknown as unknown[];
        const b = getLangChainTracingCallbacks() as unknown as unknown[];
        expect(a).toHaveLength(1);
        expect(a[0]).toBe(b[0]);
    });
});
