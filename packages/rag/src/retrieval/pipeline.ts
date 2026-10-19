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
import { composeSearchText } from '../chunking/compose.js';
import type { Reranker } from './rerankers/index.js';
import {
    SpanKind,
    withCozeLoopSpan,
    setSpanOutput,
    setSpanError,
    summarizeScoredChunks,
    truncateForSpan,
} from '../observability/index.js';
import { COZELOOP_TRACE_BUSINESS_TAGS } from '@cozeloop/ai';

export interface RetrieveDeps {
    vectorStore: VectorStore;
    bm25Retriever: BM25Retriever;
    llm: BaseChatModel;
    reranker?: Reranker;
}

export async function retrieve(
    deps: RetrieveDeps,
    query: string,
    config: RetrievalConfig,
): Promise<ScoredChunk[]> {
    return withCozeLoopSpan(
        'retrieval',
        SpanKind.Retriever,
        async (span) => {
            span?.setAttribute(COZELOOP_TRACE_BUSINESS_TAGS.RETRIEVER_PROVIDER, 'qdrant');
            const result = await retrievePipeline(deps, query, config);
            setSpanOutput(span, { query: truncateForSpan(query), top: summarizeScoredChunks(result) });
            return result;
        },
        { attributes: buildRetrievalSpanAttributes(config) },
    );
}

/** 各阶段 span 汇总的管线配置（CozeLoop attributes；禁用时不会被消费） */
function buildRetrievalSpanAttributes(config: RetrievalConfig): Record<string, string | number | boolean> {
    return {
        top_k: config.topK,
        fetch_k: config.fetchK,
        hybrid: config.hybrid.enabled,
        query_rewrite: config.queryTransform.rewrite,
        multi_query: config.queryTransform.multiQuery,
        rerank: config.rerank.enabled,
        rerank_gate: config.rerankGate.enabled,
        mmr: config.mmr.enabled,
        score_threshold: config.scoreThreshold ?? 'off',
    };
}

async function retrievePipeline(
    deps: RetrieveDeps,
    query: string,
    config: RetrievalConfig,
): Promise<ScoredChunk[]> {
    const { vectorStore, bm25Retriever, llm, reranker } = deps;

    const queries = await transformQueries(query, llm, config);

    const denseK = config.hybrid.enabled ? config.hybrid.denseTopK : config.fetchK;
    const allDenseResults: ScoredChunk[][] = [];

    for (const q of queries) {
        allDenseResults.push(
            await withCozeLoopSpan(
                'retrieval.dense',
                SpanKind.Retriever,
                async (span) => {
                    const results = await retrieveDense(vectorStore, q, denseK);
                    setSpanOutput(span, { hits: results.length });
                    return results;
                },
                { attributes: { query: truncateForSpan(q), k: denseK } },
            ),
        );
    }

    const candidates = deduplicateMerge(allDenseResults);

    const bm25Available =
        config.hybrid.enabled && bm25Retriever.isBuilt() && bm25Retriever.size() > 0;

    let finalCandidates: ScoredChunk[];

    if (bm25Available) {
        finalCandidates = await withCozeLoopSpan(
            'retrieval.bm25',
            SpanKind.Retriever,
            async (span) => {
                const sparseK = config.hybrid.sparseTopK;
                const allSparseResults: ScoredChunk[][] = [];
                for (const q of queries) {
                    allSparseResults.push(bm25Retriever.retrieve(q, sparseK));
                }
                const boostWeight = config.hybrid.sparseWeight / (config.hybrid.denseWeight + config.hybrid.sparseWeight);
                const boosted = applyBM25Boost(candidates, allSparseResults.flat(), boostWeight);
                setSpanOutput(span, {
                    hits: allSparseResults.reduce((sum, results) => sum + results.length, 0),
                    boost_weight: Number(boostWeight.toFixed(4)),
                });
                return boosted;
            },
            { attributes: { sparse_top_k: config.hybrid.sparseTopK } },
        );
    } else {
        finalCandidates = candidates;
    }

    const isHybrid = bm25Available;

    let rerankedCandidates: ScoredChunk[];

    if (config.rerank.enabled && reranker && finalCandidates.length > 0) {
        const fetchCandidates = finalCandidates.slice(0, config.fetchK);
        // rerank 输入注入 sectionPath 前缀，与 embedding/BM25/MMR 同一实现（决策 D3）
        const documents = fetchCandidates.map((c) =>
            composeSearchText(c.document.pageContent, c.document.metadata),
        );
        const primaryQuery = queries[0];
        const rerankCount = Math.min(documents.length, config.fetchK);

        rerankedCandidates = await withCozeLoopSpan(
            'retrieval.rerank',
            SpanKind.Retriever,
            async (span) => {
                const RRF_K = 60;
                const BI_ENCODER_WEIGHT = 3.0;
                const RERANK_WEIGHT = 0.15;
                try {
                    const rerankResults = await reranker!.rank(primaryQuery, documents, rerankCount);
                    const biEncoderRank = new Map<string, number>();
                    fetchCandidates.forEach((c, i) => {
                        biEncoderRank.set(getChunkId(c), i + 1);
                    });

                    const rerankRank = new Map<string, number>();
                    rerankResults.forEach((r, i) => {
                        const id = getChunkId(fetchCandidates[r.index]);
                        rerankRank.set(id, i + 1);
                    });

                    const scored = fetchCandidates.map((chunk) => {
                        const id = getChunkId(chunk);
                        const rank1 = biEncoderRank.get(id) ?? fetchCandidates.length + 1;
                        const rank2 = rerankRank.get(id) ?? fetchCandidates.length + 1;
                        const rrfScore =
                            (BI_ENCODER_WEIGHT / (RRF_K + rank1)) +
                            (RERANK_WEIGHT / (RRF_K + rank2));
                        const rerankEntry = rerankResults.find((r) => getChunkId(fetchCandidates[r.index]) === id);
                        return {
                            ...chunk,
                            score: rrfScore,
                            rerankScore: rerankEntry?.relevanceScore ?? 0,
                        };
                    });

                    scored.sort((a, b) => b.score - a.score);
                    setSpanOutput(span, { top: summarizeScoredChunks(scored.slice(0, 5)) });

                    const tail = finalCandidates.slice(config.fetchK);
                    return [...scored, ...tail];
                } catch (error) {
                    console.warn(
                        `[Rerank] API failed, falling back to fusion order: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    // span 归 withCozeLoopSpan 所有：只记错误与降级标记，end 由包装器负责
                    // （failCozeLoopSpan 会自行 end，在这里用会导致双重 end + error 状态被覆盖）
                    setSpanError(span, error);
                    setSpanOutput(span, { fallback: 'fusion-order' });
                    return finalCandidates;
                }
            },
            { attributes: { model: config.rerank.model, top_n: config.rerank.topN, candidates: documents.length } },
        );
    } else {
        rerankedCandidates = finalCandidates;
    }

    if (config.scoreThreshold !== undefined && !isHybrid && !config.rerank.enabled) {
        rerankedCandidates = rerankedCandidates.filter((c) => c.score >= config.scoreThreshold!);
    }

    if (rerankedCandidates.length === 0) {
        return [];
    }

    if (config.mmr.enabled) {
        return await withCozeLoopSpan(
            'retrieval.mmr',
            SpanKind.Retriever,
            async (span) => {
                const queryEmbedding = await vectorStore.embeddings.embedQuery(queries[0]);
                const candidateEmbeddings = await vectorStore.embeddings.embedDocuments(
                    rerankedCandidates.map(({ document }) =>
                        composeSearchText(document.pageContent, document.metadata),
                    ),
                );

                const relevanceScores = rerankedCandidates.map((c) => c.denseScore ?? c.score);

                const selectedIndexes = maximalMarginalRelevanceCustom(
                    queryEmbedding,
                    candidateEmbeddings,
                    relevanceScores,
                    config.mmr.lambda,
                    config.topK,
                );

                const selected = selectedIndexes.map((index) => rerankedCandidates[index]);
                setSpanOutput(span, {
                    lambda: config.mmr.lambda,
                    selected: selected.length,
                    from: rerankedCandidates.length,
                });
                return selected;
            },
            { attributes: { lambda: config.mmr.lambda, top_k: config.topK } },
        );
    }

    return rerankedCandidates;
}

export function deduplicateMerge(resultLists: ScoredChunk[][]): ScoredChunk[] {
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

export function applyBM25Boost(
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
    return withCozeLoopSpan(
        'retrieval.transform_queries',
        SpanKind.Retriever,
        async (span) => {
            let workingQuery = query;

            if (config.queryTransform.rewrite) {
                workingQuery = await rewriteQuery(query, llm);
            }

            let queries = [workingQuery];
            if (config.queryTransform.multiQuery) {
                const multi = await generateMultiQueries(
                    workingQuery,
                    config.queryTransform.multiQueryCount,
                    llm,
                );
                const unique = Array.from(new Set(multi));
                if (unique.length > 0) queries = unique;
            }

            setSpanOutput(span, { queries });
            return queries;
        },
        {
            attributes: {
                rewrite: config.queryTransform.rewrite,
                multi_query: config.queryTransform.multiQuery,
            },
        },
    );
}

export function maximalMarginalRelevanceCustom(
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

export function cosineSimilarity(a: number[], b: number[]): number {
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
