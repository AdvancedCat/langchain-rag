import type { VectorStore } from '@langchain/core/vectorstores';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RetrievalConfig } from '../config.js';
import type { ScoredChunk } from './types.js';
import { getChunkId } from './types.js';
import { BM25Retriever } from './retrievers/bm25.js';
import { retrieveDense } from './retrievers/dense.js';
import { deduplicate } from './retrievers/hybrid.js';
import { rewriteQuery } from './transformers/rewrite.js';
import { generateMultiQueries } from './transformers/multiQuery.js';

export interface RetrieveDeps {
    vectorStore: VectorStore;
    bm25Retriever: BM25Retriever;
    llm: BaseChatModel;
}

export async function retrieve(
    deps: RetrieveDeps,
    query: string,
    config: RetrievalConfig,
): Promise<ScoredChunk[]> {
    const { vectorStore, bm25Retriever, llm } = deps;

    const queries = await transformQueries(query, llm, config);

    const denseK = config.hybrid.enabled ? config.hybrid.denseTopK : config.fetchK;
    const allDenseResults: ScoredChunk[][] = [];

    for (const q of queries) {
        allDenseResults.push(await retrieveDense(vectorStore, q, denseK));
    }

    const candidates = deduplicateMerge(allDenseResults);

    const bm25Available =
        config.hybrid.enabled && bm25Retriever.isBuilt() && bm25Retriever.size() > 0;

    let finalCandidates: ScoredChunk[];

    if (bm25Available) {
        const sparseK = config.hybrid.sparseTopK;
        const allSparseResults: ScoredChunk[][] = [];
        for (const q of queries) {
            allSparseResults.push(bm25Retriever.retrieve(q, sparseK));
        }
        const boostWeight = config.hybrid.sparseWeight / (config.hybrid.denseWeight + config.hybrid.sparseWeight);
        finalCandidates = applyBM25Boost(candidates, allSparseResults.flat(), boostWeight);
    } else {
        finalCandidates = candidates;
    }

    const isHybrid = bm25Available;

    if (config.scoreThreshold !== undefined && !isHybrid) {
        finalCandidates = finalCandidates.filter((c) => c.score >= config.scoreThreshold!);
    }

    if (finalCandidates.length === 0) {
        return [];
    }

    if (config.mmr.enabled) {
        const queryEmbedding = await vectorStore.embeddings.embedQuery(queries[0]);
        const candidateEmbeddings = await vectorStore.embeddings.embedDocuments(
            finalCandidates.map(({ document }) => document.pageContent),
        );

        const relevanceScores = finalCandidates.map((c) => c.denseScore ?? c.score);

        const selectedIndexes = maximalMarginalRelevanceCustom(
            queryEmbedding,
            candidateEmbeddings,
            relevanceScores,
            config.mmr.lambda,
            config.topK,
        );

        return selectedIndexes.map((index) => finalCandidates[index]);
    }

    return finalCandidates;
}

function deduplicateMerge(resultLists: ScoredChunk[][]): ScoredChunk[] {
    const map = new Map<string, { chunk: ScoredChunk; bestScore: number }>();
    for (const results of resultLists) {
        for (const chunk of results) {
            const id = getChunkId(chunk);
            const existing = map.get(id);
            if (!existing || chunk.score > existing.bestScore) {
                map.set(id, {
                    chunk: { ...chunk, retrievalSource: 'dense', denseScore: chunk.score },
                    bestScore: chunk.score,
                });
            }
        }
    }
    const merged = Array.from(map.values()).map(({ chunk, bestScore }) => ({
        ...chunk,
        score: bestScore,
    }));
    merged.sort((a, b) => b.score - a.score);
    return merged;
}

function applyBM25Boost(
    denseCandidates: ScoredChunk[],
    sparseResults: ScoredChunk[],
    boostWeight: number,
): ScoredChunk[] {
    if (denseCandidates.length === 0) return [];

    const sparseScoreMap = new Map<string, number>();
    for (const chunk of sparseResults) {
        const id = getChunkId(chunk);
        if (!sparseScoreMap.has(id) || chunk.score > sparseScoreMap.get(id)!) {
            sparseScoreMap.set(id, chunk.score);
        }
    }

    const denseScores = denseCandidates.map((c) => c.denseScore ?? c.score);
    const denseMin = Math.min(...denseScores);
    const denseMax = Math.max(...denseScores);
    const denseRange = denseMax - denseMin || 1;

    const relevantSparseScores = denseCandidates
        .map((c) => sparseScoreMap.get(getChunkId(c)) ?? 0)
        .filter((s) => s > 0);
    const sparseMax = relevantSparseScores.length > 0 ? Math.max(...relevantSparseScores) : 1;
    const sparseMin = relevantSparseScores.length > 0 ? Math.min(...relevantSparseScores) : 0;
    const sparseRange = sparseMax - sparseMin || 1;

    const boosted = denseCandidates.map((chunk) => {
        const id = getChunkId(chunk);
        const denseCosine = chunk.denseScore ?? chunk.score;
        const normDense = (denseCosine - denseMin) / denseRange;
        const sparseRaw = sparseScoreMap.get(id) ?? 0;
        const normSparse = sparseRaw > 0 ? (sparseRaw - sparseMin) / sparseRange : 0;
        const finalScore = (1 - boostWeight) * normDense + boostWeight * normSparse;
        return {
            ...chunk,
            score: finalScore,
            retrievalSource: 'hybrid' as const,
        };
    });

    boosted.sort((a, b) => b.score - a.score);
    return boosted;
}

async function transformQueries(
    query: string,
    llm: BaseChatModel,
    config: RetrievalConfig,
): Promise<string[]> {
    let workingQuery = query;

    if (config.queryTransform.rewrite) {
        workingQuery = await rewriteQuery(query, llm);
    }

    if (config.queryTransform.multiQuery) {
        const multi = await generateMultiQueries(
            workingQuery,
            config.queryTransform.multiQueryCount,
            llm,
        );
        const unique = Array.from(new Set(multi));
        return unique.length > 0 ? unique : [workingQuery];
    }

    return [workingQuery];
}

function maximalMarginalRelevanceCustom(
    queryEmbedding: number[],
    embeddingList: number[][],
    relevanceScores: number[],
    lambda: number,
    topK: number,
): number[] {
    const n = embeddingList.length;
    if (n === 0) return [];
    if (topK >= n) return Array.from({ length: n }, (_, i) => i);

    const selected: number[] = [];
    const selectedSet = new Set<number>();

    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
        if (relevanceScores[i] > bestScore) {
            bestScore = relevanceScores[i];
            bestIdx = i;
        }
    }
    selected.push(bestIdx);
    selectedSet.add(bestIdx);

    while (selected.length < topK) {
        let bestMMR = -Infinity;
        let bestCandidate = -1;

        for (let i = 0; i < n; i++) {
            if (selectedSet.has(i)) continue;

            const simToQuery = relevanceScores[i];

            let maxSimToSelected = -Infinity;
            for (const j of selected) {
                const sim = cosineSimilarity(embeddingList[i], embeddingList[j]);
                if (sim > maxSimToSelected) maxSimToSelected = sim;
            }

            const mmrScore = lambda * simToQuery - (1 - lambda) * maxSimToSelected;
            if (mmrScore > bestMMR) {
                bestMMR = mmrScore;
                bestCandidate = i;
            }
        }

        if (bestCandidate === -1) break;
        selected.push(bestCandidate);
        selectedSet.add(bestCandidate);
    }

    return selected;
}

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
