import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';

function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenced) return fenced[1].trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        return text.slice(firstBrace, lastBrace + 1);
    }
    return text.trim();
}

export async function callLLMJson<T>(
    llm: BaseChatModel,
    prompt: string,
    schema: z.ZodType<T>,
    maxRetries = 2,
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await llm.invoke(prompt);
            const text = typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content);

            if (!text || text.trim().length === 0) {
                throw new Error('LLM returned empty response');
            }

            const jsonStr = extractJson(text);
            const parsed = JSON.parse(jsonStr);
            return schema.parse(parsed);
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }

    throw new Error(
        `Failed to get valid JSON after ${maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
}
