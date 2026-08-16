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

function duplicateChunkRatioAtK(retrieved: RetrievedChunk[], k: number): number {
    const topK = retrieved.slice(0, k);
    if (topK.length === 0) return 0;

    let duplicateCount = 0;
    for (let i = 0; i < topK.length; i++) {
        const current = topK[i];
        if (current.chunkIndex === undefined) continue;
        const currentIndex = current.chunkIndex;

        const duplicatesEarlierChunk = topK.slice(0, i).some(
            (previous) =>
                previous.docPath === current.docPath &&
                previous.chunkIndex !== undefined &&
                Math.abs(previous.chunkIndex - currentIndex) <= 1,
        );
        if (duplicatesEarlierChunk) duplicateCount++;
    }

    return duplicateCount / topK.length;
}

function uniqueSourceCoverageAtK(retrieved: RetrievedChunk[], k: number): number {
    if (k <= 0) return 0;
    const uniqueSources = new Set(retrieved.slice(0, k).map((chunk) => chunk.docPath));
    return uniqueSources.size / k;
}

function harmonicMean(a: number, b: number): number {
    if (a <= 0 || b <= 0) return 0;
    return (2 * a * b) / (a + b);
}

function generationContextQualityAtK(
    retrieved: RetrievedChunk[],
    query: GoldenQuery,
    k: number,
): number {
    if (!query.answerable) return 0;
    const topK = retrieved.slice(0, k);
    if (topK.length === 0) return 0;

    const sourcePrecision =
        topK.filter((chunk) => isRelevantChunk(chunk, query.expectedDocPaths)).length /
        topK.length;
    const keyword = keywordRecall(retrieved, query.expectedKeywords, k);
    const keywordRecallAtK = keyword.total > 0 ? keyword.hits / keyword.total : 0;
    const nonDuplicateRatio = 1 - duplicateChunkRatioAtK(retrieved, k);

    return harmonicMean(sourcePrecision, keywordRecallAtK) * nonDuplicateRatio;
}

function topScore(retrieved: RetrievedChunk[], override?: number): number {
    if (override !== undefined) return override;
    if (retrieved.length === 0) return 0;
    return retrieved[0].score;
}

export function evaluateQuery(
    query: GoldenQuery,
    retrieved: RetrievedChunk[],
    config: EvalConfig,
): QueryResult {
    const primaryK = config.hitRateKs[0];
    const queryTopScore = topScore(retrieved, config.topScoreOverride);
    const duplicateChunkRatioMap = Object.fromEntries(
        config.hitRateKs.map((k) => [k, duplicateChunkRatioAtK(retrieved, k)]),
    ) as Record<number, number>;
    const uniqueSourceCoverageMap = Object.fromEntries(
        config.hitRateKs.map((k) => [k, uniqueSourceCoverageAtK(retrieved, k)]),
    ) as Record<number, number>;
    const generationContextQualityMap = Object.fromEntries(
        config.hitRateKs.map((k) => [k, generationContextQualityAtK(retrieved, query, k)]),
    ) as Record<number, number>;

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
            duplicateChunkRatioAtK: duplicateChunkRatioMap,
            uniqueSourceCoverageAtK: uniqueSourceCoverageMap,
            generationContextQualityAtK: generationContextQualityMap,
            abstentionCorrect: queryTopScore < config.abstentionThreshold,
            topScore: queryTopScore,
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
        duplicateChunkRatioAtK: duplicateChunkRatioMap,
        uniqueSourceCoverageAtK: uniqueSourceCoverageMap,
        generationContextQualityAtK: generationContextQualityMap,
        abstentionCorrect: false,
        topScore: queryTopScore,
    };
}

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}
