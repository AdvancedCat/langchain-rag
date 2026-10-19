// ============================================================================
// rewrite / multiQuery → CozeLoop 父 context 透传：invoke config 必须携带
// cozeloopParentMetadata() 的产物（并行 tool 下 model span 层级修正的入口）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const mocks = vi.hoisted(() => {
    const parentMetadata = vi.fn((): { metadata?: Record<string, unknown> } => ({}));
    return { parentMetadata };
});

vi.mock('../../../observability/spans.js', () => ({
    cozeloopParentMetadata: mocks.parentMetadata,
}));

import { rewriteQuery, clearRewriteCache } from '../rewrite.js';
import { generateMultiQueries, clearMultiQueryCache } from '../multiQuery.js';

function fakeLLM(content: string) {
    return {
        invoke: vi.fn(async () => ({ content })),
    } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
    clearRewriteCache();
    clearMultiQueryCache();
    mocks.parentMetadata.mockReturnValue({});
});

describe('transformers → CozeLoop 父 context 透传', () => {
    it('rewriteQuery 把 cozeloopParentMetadata() 展开进 invoke config', async () => {
        const metadata = { 'cozeloop.parent_context': { marker: 'ctx' } };
        mocks.parentMetadata.mockReturnValue({ metadata });
        const llm = fakeLLM('向量检索 关键词');
        await rewriteQuery('原始问题', llm);
        expect(llm.invoke).toHaveBeenCalledWith(
            [expect.anything()],
            expect.objectContaining({ metadata }),
        );
    });

    it('CozeLoop 禁用（helper 返回空对象）时 invoke config 只有 temperature，行为不变', async () => {
        const llm = fakeLLM('精确查询');
        await rewriteQuery('原始问题', llm);
        expect(llm.invoke).toHaveBeenCalledWith([expect.anything()], { temperature: 0.1 });
    });

    it('generateMultiQueries 同样透传 metadata', async () => {
        mocks.parentMetadata.mockReturnValue({
            metadata: { 'cozeloop.parent_context': { marker: 'ctx' } },
        });
        const llm = fakeLLM('["q1","q2"]');
        await generateMultiQueries('问题', 2, llm);
        expect(llm.invoke).toHaveBeenCalledWith(
            [expect.anything()],
            expect.objectContaining({ metadata: expect.anything() }),
        );
    });
});
