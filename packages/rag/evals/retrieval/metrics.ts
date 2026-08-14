import type { GoldenQuery, RetrievedChunk, QueryResult, EvalConfig } from './types.js';

function isRelevantChunk(chunk: RetrievedChunk, expectedDocPaths: string[]): boolean {
    return expectedDocPaths.includes(chunk.docPath);
}

function hitAtK(retrieved: RetrievedChunk[], expectedDocPaths: string[], k: number): boolean {
    return retrieved.slice(0, k).some((c) => isRelevantChunk(c, expectedDocPaths));
}

function precisionAtK(retrieved: RetrievedChunk[], expectedDocPaths: string[], k: number): number {
    const topK = retrieved.slice(0, k);
    if (topK.length === 0) return 0;
    const relevant = topK.filter((c) => isRelevantChunk(c, expectedDocPaths)).length;
    return relevant / k;
}

function reciprocalRank(retrieved: RetrievedChunk[], expectedDocPaths: string[]): number {
    for (let i = 0; i < retrieved.length; i++) {
        if (isRelevantChunk(retrieved[i], expectedDocPaths)) {
            return 1 / (i + 1);
        }
    }
    return 0;
}

function ndcgAtK(
    retrieved: RetrievedChunk[],
    expectedDocPaths: string[],
    k: number,
): number {
    const topK = retrieved.slice(0, k);
    let dcg = 0;

    for (let i = 0; i < topK.length; i++) {
        if (isRelevantChunk(topK[i], expectedDocPaths)) {
            dcg += 1 / Math.log2(i + 2);
        }
    }

    let idcg = 0;
    for (let i = 0; i < k; i++) {
        idcg += 1 / Math.log2(i + 2);
    }

    return dcg / idcg;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordRecall(
    retrieved: RetrievedChunk[],
    expectedKeywords: string[],
    topK: number,
): { hits: number; total: number } {
    if (expectedKeywords.length === 0) return { hits: 0, total: 0 };
    const allContent = retrieved
        .slice(0, topK)
        .map((c) => c.content)
        .join('\n')
        .toLowerCase();
    const hits = expectedKeywords.filter((kw) => {
        const pattern = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`);
        return pattern.test(allContent);
    }).length;
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
    const primaryK = config.hitRateKs[0];

    if (!query.answerable) {
        return {
            query,
            retrieved,
            hitAtK: Object.fromEntries(config.hitRateKs.map((k) => [k, false])) as Record<number, boolean>,
            precisionAtK: Object.fromEntries(config.hitRateKs.map((k) => [k, 0])) as Record<number, number>,
            reciprocalRank: 0,
            ndcgAtK: Object.fromEntries(config.ndcgKs.map((k) => [k, 0])) as Record<number, number>,
            keywordHits: 0,
            keywordTotal: 0,
            abstentionCorrect: topScore(retrieved) < config.abstentionThreshold,
            topScore: topScore(retrieved),
        };
    }

    const hitMap: Record<number, boolean> = {};
    const precisionMap: Record<number, number> = {};
    const ndcgMap: Record<number, number> = {};

    for (const k of config.hitRateKs) {
        hitMap[k] = hitAtK(retrieved, query.expectedDocPaths, k);
        precisionMap[k] = precisionAtK(retrieved, query.expectedDocPaths, k);
    }
    for (const k of config.ndcgKs) {
        ndcgMap[k] = ndcgAtK(retrieved, query.expectedDocPaths, k);
    }

    const { hits, total } = keywordRecall(retrieved, query.expectedKeywords, primaryK);

    return {
        query,
        retrieved,
        hitAtK: hitMap,
        precisionAtK: precisionMap,
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
