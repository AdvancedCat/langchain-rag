import type { VectorStore } from '@langchain/core/vectorstores';
import { maximalMarginalRelevance } from '@langchain/core/utils/math';
import type { RetrievalConfig } from '../config.js';
import type { ScoredChunk } from './types.js';

/**
 * Retrieve scored candidates, optionally remove low-similarity noise, then
 * select a diverse top-k set with maximal marginal relevance.
 */
export async function retrieve(
    vectorStore: VectorStore,
    query: string,
    config: RetrievalConfig,
): Promise<ScoredChunk[]> {
    const queryEmbedding = await vectorStore.embeddings.embedQuery(query);
    const candidates = await vectorStore.similaritySearchVectorWithScore(
        queryEmbedding,
        config.fetchK,
    );

    const filtered: ScoredChunk[] = candidates
        .filter(([, score]) =>
            config.scoreThreshold === undefined || score >= config.scoreThreshold,
        )
        .map(([document, score]) => ({ document, score }));

    if (!config.mmr.enabled) {
        return filtered.slice(0, config.topK);
    }
    if (filtered.length === 0) {
        return [];
    }

    const candidateEmbeddings = await vectorStore.embeddings.embedDocuments(
        filtered.map(({ document }) => document.pageContent),
    );
    const selectedIndexes = maximalMarginalRelevance(
        queryEmbedding,
        candidateEmbeddings,
        config.mmr.lambda,
        config.topK,
    );

    return selectedIndexes.map((index) => filtered[index]);
}
