import type { VectorStore } from '@langchain/core/vectorstores';
import type { ScoredChunk } from '../types.js';

export async function retrieveDense(
    vectorStore: VectorStore,
    query: string,
    k: number,
): Promise<ScoredChunk[]> {
    const queryEmbedding = await vectorStore.embeddings.embedQuery(query);
    const results = await vectorStore.similaritySearchVectorWithScore(queryEmbedding, k);
    return results.map(([document, score]) => ({
        document,
        score,
        retrievalSource: 'dense' as const,
    }));
}
