import type { GoldenQuery, RetrievedChunk, QueryResult, EvalConfig } from './types.js';

function isRelevantChunk(chunk: RetrievedChunk, expectedDocPaths: string[]): boolean {
    return expectedDocPaths.includes(chunk.docPath);
}

function hitAtK(retrieved: RetrievedChunk[], expectedDocPaths: string[], k: number): boolean {
    return retrieved.slice(0, k).some((c) => isRelevantChunk(c, expectedDocPaths));
}

function reciprocalRank(retrieved: RetrievedChunk[], expectedDocPaths: string[]): number {
    for (let i = 0; i < retrieved.length; i++) {
        if (isRelevantChunk(retrieved[i], expectedDocPaths)) {
            return 1 / (i + 1);
        }
    }
    return 0;
}

function dcgAtK(retrieved: RetrievedChunk[], expectedDocPaths: string[], k: number): number {
    let dcg = 0;
    const topK = retrieved.slice(0, k);
    for (let i = 0; i < topK.length; i++) {
        if (isRelevantChunk(topK[i], expectedDocPaths)) {
            dcg += 1 / Math.log2(i + 2);
        }
    }
    return dcg;
}

function ndcgAtK(retrieved: RetrievedChunk[], expectedDocPaths: string[], k: number): number {
    const topK = retrieved.slice(0, k);
    let dcg = 0;
    let numRelevantInTopK = 0;

    for (let i = 0; i < topK.length; i++) {
        if (isRelevantChunk(topK[i], expectedDocPaths)) {
            dcg += 1 / Math.log2(i + 2);
            numRelevantInTopK++;
        }
    }

    if (numRelevantInTopK === 0) return 0;

    let idcg = 0;
    for (let i = 0; i < numRelevantInTopK; i++) {
        idcg += 1 / Math.log2(i + 2);
    }

    return dcg / idcg;
}

function keywordRecall(retrieved: RetrievedChunk[], expectedKeywords: string[]): { hits: number; total: number } {
    if (expectedKeywords.length === 0) return { hits: 0, total: 0 };
    const allContent = retrieved.map((c) => c.content).join('\n').toLowerCase();
    const hits = expectedKeywords.filter((kw) => allContent.includes(kw.toLowerCase())).length;
    return { hits, total: expectedKeywords.length };
}

function topScore(retrieved: RetrievedChunk[]): number {
    if (retrieved.length === 0) return 0;
    return retrieved[0].score;
}

export function evaluateQuery(
    query: GoldenQuery,
    retrieved: RetrievedChunk[],
    config: EvalConfig,
): QueryResult {
    if (!query.answerable) {
        return {
            query,
            retrieved,
            hitAtK: Object.fromEntries(config.hitRateKs.map((k) => [k, false])) as Record<number, boolean>,
            reciprocalRank: 0,
            ndcgAtK: Object.fromEntries(config.ndcgKs.map((k) => [k, 0])) as Record<number, number>,
            keywordHits: 0,
            keywordTotal: 0,
            abstentionCorrect: topScore(retrieved) < config.abstentionThreshold,
            topScore: topScore(retrieved),
        };
    }

    const hitMap: Record<number, boolean> = {};
    const ndcgMap: Record<number, number> = {};

    for (const k of config.hitRateKs) {
        hitMap[k] = hitAtK(retrieved, query.expectedDocPaths, k);
    }
    for (const k of config.ndcgKs) {
        ndcgMap[k] = ndcgAtK(retrieved, query.expectedDocPaths, k);
    }

    const { hits, total } = keywordRecall(retrieved, query.expectedKeywords);

    return {
        query,
        retrieved,
        hitAtK: hitMap,
        reciprocalRank: reciprocalRank(retrieved, query.expectedDocPaths),
        ndcgAtK: ndcgMap,
        keywordHits: hits,
        keywordTotal: total,
        abstentionCorrect: false,
        topScore: topScore(retrieved),
    };
}

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}
