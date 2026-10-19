// ============================================================================
// token 用量解析与跨调用累计
//
// readTokenUsage：CozeLoop span 与 run.usage 收集器共用的逐级回退解析；
// createUsageCollector：api 侧随流收集本轮全部 LLM 调用用量，经 CUSTOM
// run.usage 事件透出给前端（正文底部元信息行）。
// ============================================================================

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

export interface NormalizedTokenUsage {
    input: number | undefined;
    output: number | undefined;
    total: number | undefined;
}

export interface TokenUsageTotal {
    input: number;
    output: number;
    total: number;
}

export function readFiniteNumber(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

/**
 * token 用量按版本/路径形态各异，逐级回退：
 * - `message.usage_metadata`：@langchain/openai 1.x 流式聚合 chunk 与非流式 AIMessage 均携带（标准 snake_case）；
 * - `llmOutput.tokenUsage`：1.x 非流式/流式 llmOutput（camelCase，core _streamIterator 组装）；
 * - `llmOutput.token_usage`：0.x 旧字段（snake_case），保留兼容。
 */
export function readTokenUsage(
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

/**
 * 跨 LLM 调用累计本轮用量：handleLLMEnd 每次 LLM 调用恰好触发一次
 * （流式聚合 usage 在末 chunk 汇齐），主代理 + 子代理逐一累加即为整轮。
 * 每次调用先取 generation 级 usage_metadata，整级缺失才回退 llmOutput 一次，
 * 避免多代生成时按代数重复累加。
 */
export class UsageCollectorHandler extends BaseCallbackHandler {
    name = 'rag_usage_collector';
    private inputTokens = 0;
    private outputTokens = 0;
    private totalTokens = 0;
    private seen = false;

    handleLLMEnd(output: LLMResult): void {
        const generations = output.generations.flat();
        const usage =
            generations.map((generation) => readTokenUsage(generation, undefined)).find((value) => value !== undefined) ??
            readTokenUsage(generations[0], output.llmOutput);
        if (!usage) return;
        this.seen = true;
        this.inputTokens += usage.input ?? 0;
        this.outputTokens += usage.output ?? 0;
        this.totalTokens += usage.total ?? 0;
    }

    /** 无任何 LLM 调用（或全部解析失败）时返回 null，不发射事件 */
    total(): TokenUsageTotal | null {
        return this.seen ? { input: this.inputTokens, output: this.outputTokens, total: this.totalTokens } : null;
    }
}

export function createUsageCollector(): UsageCollectorHandler {
    return new UsageCollectorHandler();
}
