import { describe, expect, it } from 'vitest';
import type { LLMResult } from '@langchain/core/outputs';
import { createUsageCollector } from '../token-usage.js';

/** 最小 LLMResult 构造（handleLLMEnd 只读 generations 与 llmOutput） */
function llmResult(generations: Array<{ message?: { usage_metadata?: Record<string, number> } }>, llmOutput?: Record<string, unknown>): LLMResult {
    return { generations: [generations], llmOutput } as unknown as LLMResult;
}

describe('UsageCollectorHandler', () => {
    it('generation.message.usage_metadata（1.x 流式聚合形态）', () => {
        const collector = createUsageCollector();
        collector.handleLLMEnd(llmResult([{ message: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }]));
        expect(collector.total()).toEqual({ input: 10, output: 5, total: 15 });
    });

    it('llmOutput 回退：tokenUsage（camelCase）与 token_usage（0.x）', () => {
        const collector = createUsageCollector();
        collector.handleLLMEnd(llmResult([{}], { tokenUsage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } }));
        expect(collector.total()).toEqual({ input: 7, output: 3, total: 10 });

        const legacy = createUsageCollector();
        legacy.handleLLMEnd(llmResult([{}], { token_usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }));
        expect(legacy.total()).toEqual({ input: 6, output: 4, total: 10 });
    });

    it('跨多次 LLM 调用累加（主代理 + 子代理）', () => {
        const collector = createUsageCollector();
        collector.handleLLMEnd(llmResult([{ message: { usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }]));
        collector.handleLLMEnd(llmResult([{ message: { usage_metadata: { input_tokens: 50, output_tokens: 30, total_tokens: 80 } } }]));
        expect(collector.total()).toEqual({ input: 150, output: 50, total: 200 });
    });

    it('多代生成时 llmOutput 级回退只计一次，不按代数重复累加', () => {
        const collector = createUsageCollector();
        collector.handleLLMEnd(llmResult([{}, {}], { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }));
        expect(collector.total()).toEqual({ input: 10, output: 5, total: 15 });
    });

    it('generation 级 usage_metadata 与 llmOutput 同时存在时只取前者，不叠加', () => {
        const collector = createUsageCollector();
        collector.handleLLMEnd(
            llmResult(
                [{ message: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }],
                { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
            ),
        );
        expect(collector.total()).toEqual({ input: 10, output: 5, total: 15 });
    });

    it('无任何用量数据 → total() 返回 null', () => {
        const collector = createUsageCollector();
        expect(collector.total()).toBeNull();
        collector.handleLLMEnd(llmResult([{ message: {} }], {}));
        expect(collector.total()).toBeNull();
    });
});
