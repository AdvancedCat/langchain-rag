import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';

const REWRITE_PROMPT = `你是一个专业的搜索查询优化器。你的任务是将用户的原始问题改写为适合技术文档检索的精确查询。

规则：
1. 提取核心技术概念、API 名称、错误信息、配置项等关键术语
2. 去除口语化表达，使查询更加书面化和精确
3. 保留原始查询中的所有技术关键词
4. 如果原始查询已经足够精确，只需进行最小化调整
5. 只输出改写后的查询，不要加任何解释、前缀或引号

原始查询：{query}

改写后的查询：`;

const QUERY_REWRITE_CACHE_MAX = 500;
const queryRewriteCache = new Map<string, string>();

/**
 * 兼容 string 与多段 content block 两种响应形态。
 * agent 进程内共享的 ChatOpenAI 实例可能返回块数组，直接 toString() 会得到
 * "[object Object],[object Object]" 并污染下游 embedding 查询。
 */
export function extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part !== null && typeof part === 'object' && 'text' in part) {
                    const text = (part as { text?: unknown }).text;
                    return typeof text === 'string' ? text : '';
                }
                return '';
            })
            .join('');
    }
    // 静默降级正是 "[object Object]" bug 当初长期未被发现的原因：形态漂移必须立刻可见
    console.warn(
        `[extractTextContent] Unrecognized LLM content shape (${typeof content}); ` +
            'returning empty string, callers will fall back to the original query',
    );
    return '';
}

export async function rewriteQuery(
    query: string,
    llm: BaseChatModel,
): Promise<string> {
    const cached = queryRewriteCache.get(query);
    if (cached) {
        return cached;
    }

    const prompt = REWRITE_PROMPT.replace('{query}', query);

    try {
        const response = await llm.invoke([new HumanMessage(prompt)], {
            temperature: 0.1,
        } as Parameters<typeof llm.invoke>[1]);

        const text = extractTextContent(response.content).trim();

        const rewritten = text
            .replace(/^["'「」『』\s]+|["'「」『』\s]+$/g, '')
            .replace(/^(改写后的查询[：:]\s*)/i, '')
            .trim();

        const finalQuery = rewritten.length > 0 ? rewritten : query;

        if (queryRewriteCache.size >= QUERY_REWRITE_CACHE_MAX) {
            const firstKey = queryRewriteCache.keys().next().value;
            if (firstKey) queryRewriteCache.delete(firstKey);
        }
        queryRewriteCache.set(query, finalQuery);

        return finalQuery;
    } catch (error) {
        console.warn('⚠️  Query rewrite failed, using original query:', error instanceof Error ? error.message : String(error));
        return query;
    }
}

export function clearRewriteCache(): void {
    queryRewriteCache.clear();
}
