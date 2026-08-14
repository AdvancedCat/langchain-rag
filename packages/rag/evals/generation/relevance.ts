import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { RelevanceResult } from './types.js';
import { callLLMJson } from './llm-json.js';

const QuestionsSchema = z.object({
    questions: z.array(z.string()),
});

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function evaluateRelevance(
    llm: BaseChatModel,
    embeddings: EmbeddingsInterface,
    question: string,
    answer: string,
    numQuestions: number,
): Promise<RelevanceResult> {
    const prompt = `Generate ${numQuestions} distinct questions that the following answer could address. The questions should be in the same language as the answer. Rewrite from different angles but all must be answerable by the answer.

Return ONLY a JSON object in this exact format:
{"questions": ["question 1", "question 2", "question 3"]}

Answer:
${answer}`;

    const result = await callLLMJson(llm, prompt, QuestionsSchema);
    const generatedQuestions: string[] = (result.questions ?? []).slice(0, numQuestions);

    if (generatedQuestions.length === 0) {
        return {
            generatedQuestions: [],
            similarities: [],
            score: 0,
        };
    }

    const allTexts = [question, ...generatedQuestions];
    const allEmbeddings = await embeddings.embedDocuments(allTexts);
    const originalEmbedding = allEmbeddings[0];
    const generatedEmbeddings = allEmbeddings.slice(1);

    const similarities = generatedEmbeddings.map((emb) =>
        cosineSimilarity(originalEmbedding, emb),
    );

    const score = similarities.reduce((a, b) => a + b, 0) / similarities.length;

    return {
        generatedQuestions,
        similarities,
        score,
    };
}
