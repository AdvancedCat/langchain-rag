import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';

const MULTI_QUERY_PROMPT = `你是一个搜索专家。对于下面的技术问题，生成 {count} 个不同角度的检索查询，以覆盖技术文档库中可能相关的内容。

多角度策略：
1. 直接使用原始问题的核心术语
2. 使用相关的技术术语、API名称、同义词
3. 从问题涉及的概念、用法、错误排查等不同侧面提问

用户问题：{query}

请以JSON数组格式输出{count}个查询字符串，不要有任何其他解释或markdown标记：
["query1", "query2", "query3"]`;

const MULTI_QUERY_CACHE_MAX = 200;
const multiQueryCache = new Map<string, string[]>();

function parseQueryArray(text: string, count: number): string[] {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        return [];
    }
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((item): item is string => typeof item === 'string')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
                .slice(0, count);
        }
    } catch {
        // fall through
    }
    return [];
}

export async function generateMultiQueries(
    query: string,
    count: number,
    llm: BaseChatModel,
): Promise<string[]> {
    const cacheKey = `${query}#${count}`;
    const cached = multiQueryCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const prompt = MULTI_QUERY_PROMPT
        .replace('{count}', String(count))
        .replace('{query}', query);

    try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const text = response.content.toString().trim();
        const queries = parseQueryArray(text, count);

        const result = queries.length > 0 ? queries : [query];

        if (multiQueryCache.size >= MULTI_QUERY_CACHE_MAX) {
            const firstKey = multiQueryCache.keys().next().value;
            if (firstKey) multiQueryCache.delete(firstKey);
        }
        multiQueryCache.set(cacheKey, result);

        return result;
    } catch (error) {
        console.warn('⚠️  Multi-query generation failed, using original query:', error instanceof Error ? error.message : String(error));
        return [query];
    }
}

export function clearMultiQueryCache(): void {
    multiQueryCache.clear();
}
