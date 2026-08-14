import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { RetrievedChunk } from '../shared/types.js';

function getEvalLLM(): BaseChatModel {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY is required for generation evaluation.');
    }
    return new ChatOpenAI({
        model: process.env.LLM_MODEL ?? 'deepseek-v4-flash',
        apiKey,
        configuration: {
            baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        },
        temperature: 0,
        maxTokens: 8192,
        timeout: 120000,
    });
}

const RAG_SYSTEM_PROMPT = `You are a documentation Q&A assistant. Answer the user's question based ONLY on the provided documentation excerpts.

Rules:
1. Use only information present in the excerpts.
2. If the excerpts do not contain enough information to answer, respond with exactly: "根据提供的文档，我无法找到该问题的答案。"
3. Be concise and accurate. Cite source names when relevant.`;

function formatContext(chunks: RetrievedChunk[]): string {
    return chunks
        .map((chunk, i) => {
            const source = chunk.docPath.split('/').pop() ?? 'unknown';
            return `[Excerpt ${i + 1} — ${source}]\n${chunk.content}`;
        })
        .join('\n\n---\n\n');
}

export async function generateAnswer(
    question: string,
    chunks: RetrievedChunk[],
): Promise<string> {
    const llm = getEvalLLM();
    const context = formatContext(chunks);

    const response = await llm.invoke([
        ['system', RAG_SYSTEM_PROMPT],
        ['human', `Documentation excerpts:\n\n${context}\n\nQuestion: ${question}`],
    ]);

    return typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
}

export { getEvalLLM };
