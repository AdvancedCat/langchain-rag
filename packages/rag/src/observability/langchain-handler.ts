// ============================================================================
// LangChain → CozeLoop 回调 handler：为每次 LLM 调用生成 model span
//
// 注册两次、run_id 幂等：
// - 实例级（getLLM({ callbacks })）——工具内部直调的 llm.invoke（query rewrite、
//   multiQuery）不在 graph 的 config 传播链上，只有实例级回调能捕获；
// - config 级（streamEvents 选项）——兜底子代理等非共享实例的调用。
// 同一 run 可能双投递，span map 按 run_id 幂等去重（方案 §3.4）。
//
// 仅观测 LLM：chain 结构由 run 根 span + 检索阶段 span 承担，工具 span 由
// 工具体外层 withCozeLoopSpan('search_documentation', tool) 生成（保证其内部
// 的 retrieval 子 span 正确挂到工具下）。
// ============================================================================

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import {
    COZELOOP_TRACE_BUSINESS_TAGS,
    context,
} from '@cozeloop/ai';
import { isCozeLoopEnabled } from './cozeloop.js';
import {
    COZELOOP_PARENT_CONTEXT_METADATA,
    startCozeLoopSpan,
    setSpanInput,
    setSpanOutput,
    setSpanError,
    truncateForSpan,
    type Span,
} from './spans.js';

/** OTel Context（经 @cozeloop/ai 再导出的全局单例，宿主不得直依赖 @opentelemetry/api） */
type OtelContext = ReturnType<typeof context.active>;

const MODEL_SPAN_TYPE = 'model';

export class CozeLoopLangChainCallbackHandler extends BaseCallbackHandler {
    name = 'cozeloop_langchain';
    ignoreChain = true;

    private readonly spans = new Map<string, Span>();
    /** run → 首 token 时刻（微秒），handleLLMEnd 汇报为 START_TIME_FIRST_RESP（TTFT） */
    private readonly firstTokenMicros = new Map<string, number>();
    /** run → 配置的模型名（LLM 序列化 kwargs），handleLLMEnd 汇报为 MODEL_NAME */
    private readonly modelNames = new Map<string, string>();

    handleLLMStart(
        llm: Serialized,
        prompts: string[],
        runId: string,
        _parentRunId?: string,
        _extraParams?: Record<string, unknown>,
        _tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string,
    ): void {
        if (!isCozeLoopEnabled() || this.spans.has(runId)) return;
        // 工具体内直调的 llm.invoke（rewrite/multiQuery）在回调分发时 ambient 只剩
        // run 根（ALS 断链），invoke 侧经 config.metadata 显式携带父 context 修正层级；
        // 未携带时（主模型/子代理调用）回退 ambient，行为与现状一致
        const parentContext = metadata?.[COZELOOP_PARENT_CONTEXT_METADATA] as OtelContext | undefined;
        const span = startCozeLoopSpan(runName ?? 'llm', MODEL_SPAN_TYPE, { parent: parentContext });
        if (!span) return;
        this.spans.set(runId, span);
        // ChatOpenAI 的流式路径 llmOutput 不带 model_name（罗盘上显示 unknown 的
        // 根因），这里从序列化 kwargs（this.toJSON()）取配置的模型名兜底
        const kwargs = (llm as { kwargs?: Record<string, unknown> } | null)?.kwargs;
        const model = readStringProp(kwargs, 'model') ?? readStringProp(kwargs, 'model_name');
        if (model) this.modelNames.set(runId, model);
        setSpanInput(span, {
            messages: [{ role: 'user', content: truncateForSpan(prompts.join('\n\n')) }],
        });
    }

    handleLLMNewToken(_token: string, _idx: unknown, runId: string): void {
        if (this.spans.has(runId) && !this.firstTokenMicros.has(runId)) {
            this.firstTokenMicros.set(runId, Date.now() * 1000);
        }
    }

    handleLLMEnd(output: LLMResult, runId: string): void {
        const span = this.spans.get(runId);
        if (!span) return;
        this.spans.delete(runId);

        const generation = output?.generations?.[0]?.[0];
        const text =
            generation && typeof generation === 'object' && 'text' in generation
                ? String((generation as { text?: unknown }).text ?? '')
                : '';
        setSpanOutput(span, {
            choices: [{ message: { role: 'assistant', content: truncateForSpan(text) } }],
        });

        const llmOutput = output?.llmOutput as Record<string, unknown> | undefined;
        const configuredModel = this.modelNames.get(runId);
        this.modelNames.delete(runId);
        // 模型名优先级：Start 提取的配置值 > 服务端回显（finish chunk 的
        // generationInfo→response_metadata.model_name，仅流式）> llmOutput（0.x 旧字段）> env
        const servedModel = readStringProp(
            (generation as { message?: { response_metadata?: Record<string, unknown> } } | undefined)?.message
                ?.response_metadata,
            'model_name',
        );
        const modelName =
            configuredModel ??
            servedModel ??
            (typeof llmOutput?.model_name === 'string' ? llmOutput.model_name : undefined) ??
            (process.env.LLM_MODEL ?? 'unknown');
        span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.MODEL_NAME, modelName);
        span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.MODEL_PROVIDER, 'deepseek');
        const usage = readTokenUsage(generation, llmOutput);
        if (usage) {
            if (usage.input !== undefined) {
                span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.INPUT_TOKENS, usage.input);
            }
            if (usage.output !== undefined) {
                span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.OUTPUT_TOKENS, usage.output);
            }
            if (usage.total !== undefined) {
                span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.TOKENS, usage.total);
            }
        }
        const firstResp = this.firstTokenMicros.get(runId);
        this.firstTokenMicros.delete(runId);
        if (firstResp !== undefined) {
            span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.START_TIME_FIRST_RESP, firstResp);
            span.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.STREAM, true);
        }
        span.end();
    }

    handleLLMError(err: Error, runId: string): void {
        const span = this.spans.get(runId);
        if (!span) return;
        this.spans.delete(runId);
        this.firstTokenMicros.delete(runId);
        this.modelNames.delete(runId);
        setSpanError(span, err);
        span.end();
    }
}

let handlerSingleton: CozeLoopLangChainCallbackHandler | undefined;

export function getCozeLoopCallbackHandler(): CozeLoopLangChainCallbackHandler {
    handlerSingleton ??= new CozeLoopLangChainCallbackHandler();
    return handlerSingleton;
}

/** 禁用时返回空数组（LangChain 接受空 callbacks，调用方无需分支） */
export function getLangChainTracingCallbacks(): Callbacks {
    if (!isCozeLoopEnabled()) return [];
    return [getCozeLoopCallbackHandler()];
}

function readFiniteNumber(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

function readStringProp(source: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = source?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface NormalizedTokenUsage {
    input: number | undefined;
    output: number | undefined;
    total: number | undefined;
}

/**
 * token 用量按版本/路径形态各异，逐级回退：
 * - `message.usage_metadata`：@langchain/openai 1.x 流式聚合 chunk 与非流式 AIMessage 均携带（标准 snake_case）；
 * - `llmOutput.tokenUsage`：1.x 非流式/流式 llmOutput（camelCase，core _streamIterator 组装）；
 * - `llmOutput.token_usage`：0.x 旧字段（snake_case），保留兼容。
 */
function readTokenUsage(
    generation: unknown,
    llmOutput: Record<string, unknown> | undefined,
): NormalizedTokenUsage | undefined {
    const usageMetadata = (generation as { message?: { usage_metadata?: Record<string, unknown> } } | undefined)
        ?.message?.usage_metadata;
    const fromMetadata = pickUsage(usageMetadata, 'input_tokens', 'output_tokens', 'total_tokens');
    if (fromMetadata) return fromMetadata;
    const fromCamel = pickUsage(llmOutput?.tokenUsage as Record<string, unknown> | undefined, 'promptTokens', 'completionTokens', 'totalTokens');
    if (fromCamel) return fromCamel;
    return pickUsage(llmOutput?.token_usage as Record<string, unknown> | undefined, 'prompt_tokens', 'completion_tokens', 'total_tokens');
}

function pickUsage(
    source: Record<string, unknown> | undefined,
    inputKey: string,
    outputKey: string,
    totalKey: string,
): NormalizedTokenUsage | undefined {
    if (!source) return undefined;
    const usage: NormalizedTokenUsage = {
        input: readFiniteNumber(source[inputKey]),
        output: readFiniteNumber(source[outputKey]),
        total: readFiniteNumber(source[totalKey]),
    };
    return usage.input !== undefined || usage.output !== undefined || usage.total !== undefined
        ? usage
        : undefined;
}
