import { describe, it, expect } from 'vitest';
import type { GoldenQuery, RetrievedChunk, EvalConfig } from '../types.js';
import {
    hitAtK,
    precisionAtK,
    reciprocalRank,
    ndcgAtK,
    keywordRecall,
    duplicateChunkRatioAtK,
    uniqueSourceCoverageAtK,
    generationContextQualityAtK,
    evaluateQuery,
    mean,
} from '../metrics.js';

function rc(
    docPath: string,
    overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
    return {
        docPath,
        chunkIndex: 0,
        score: 0.5,
        content: `content of ${docPath}`,
        rank: 1,
        ...overrides,
    };
}

const golden: GoldenQuery = {
    id: 'q001',
    query: '如何配置 hybrid search',
    type: 'api_usage',
    difficulty: 'easy',
    expectedDocPaths: ['docs/a.md'],
    expectedKeywords: ['hybrid'],
    answerable: true,
};

describe('hitAtK', () => {
    const retrieved = [rc('docs/a.md'), rc('docs/b.md'), rc('docs/c.md')];

    it('is true when a relevant doc lands within k', () => {
        expect(hitAtK(retrieved, ['docs/b.md'], 2)).toBe(true);
    });

    it('is false when the relevant doc appears after k', () => {
        expect(hitAtK(retrieved, ['docs/b.md'], 1)).toBe(false);
    });

    it('is false for empty retrieval', () => {
        expect(hitAtK([], ['docs/a.md'], 4)).toBe(false);
    });
});

describe('precisionAtK', () => {
    it('counts relevant docs over k, not over retrieved length', () => {
        const retrieved = [rc('docs/a.md'), rc('docs/b.md')];
        expect(precisionAtK(retrieved, ['docs/a.md', 'docs/b.md'], 4)).toBe(0.5);
    });

    it('handles fully relevant top-k', () => {
        const retrieved = [rc('docs/a.md'), rc('docs/b.md')];
        expect(precisionAtK(retrieved, ['docs/a.md', 'docs/b.md'], 2)).toBe(1);
    });

    it('returns 0 when nothing is relevant', () => {
        expect(precisionAtK([rc('docs/x.md')], ['docs/a.md'], 1)).toBe(0);
    });

    it('returns 0 for empty retrieval', () => {
        expect(precisionAtK([], ['docs/a.md'], 4)).toBe(0);
    });
});

describe('reciprocalRank', () => {
    it('returns 1 when the first result is relevant', () => {
        expect(reciprocalRank([rc('docs/a.md')], ['docs/a.md'])).toBe(1);
    });

    it('returns 1/rank for the first relevant position', () => {
        const retrieved = [rc('docs/x.md'), rc('docs/y.md'), rc('docs/a.md')];
        expect(reciprocalRank(retrieved, ['docs/a.md'])).toBeCloseTo(1 / 3, 10);
    });

    it('returns 0 when nothing is relevant', () => {
        expect(reciprocalRank([rc('docs/x.md')], ['docs/a.md'])).toBe(0);
    });
});

describe('ndcgAtK', () => {
    it('discounts relevant docs found deeper in the ranking', () => {
        // relevant at rank 1 and 3: dcg = 1 + 1/log2(4) = 1.5
        // idcg@3 = 1 + 1/log2(3) + 1/log2(4)
        const retrieved = [rc('docs/a.md'), rc('docs/x.md'), rc('docs/a.md')];
        const expected = 1.5 / (1 + 1 / Math.log2(3) + 0.5);
        expect(ndcgAtK(retrieved, ['docs/a.md'], 3)).toBeCloseTo(expected, 10);
    });

    it('reaches 1 when all top-k are relevant', () => {
        const retrieved = [rc('docs/a.md'), rc('docs/a.md')];
        expect(ndcgAtK(retrieved, ['docs/a.md'], 2)).toBe(1);
    });

    it('penalizes k slots the retrieval could not fill', () => {
        // 1 relevant in 2 retrieved, judged at k=4: idcg still sums 4 slots
        const retrieved = [rc('docs/a.md'), rc('docs/x.md')];
        const expected = 1 / (1 + 1 / Math.log2(3) + 0.5 + 1 / Math.log2(5));
        expect(ndcgAtK(retrieved, ['docs/a.md'], 4)).toBeCloseTo(expected, 10);
    });

    it('returns 0 when nothing is relevant', () => {
        expect(ndcgAtK([rc('docs/x.md')], ['docs/a.md'], 4)).toBe(0);
    });
});

describe('keywordRecall', () => {
    it('matches keywords case-insensitively with word boundaries', () => {
        const retrieved = [rc('docs/a.md', { content: 'Vector store supports Hybrid Search' })];
        expect(keywordRecall(retrieved, ['vector', 'hybrid', 'qdrant'], 4)).toEqual({
            hits: 2,
            total: 3,
        });
    });

    it('does not match keywords embedded in longer words', () => {
        const retrieved = [rc('docs/a.md', { content: 'stores data in storage' })];
        expect(keywordRecall(retrieved, ['store'], 4)).toEqual({ hits: 0, total: 1 });
    });

    it('only considers the top-k chunks', () => {
        const retrieved = [
            rc('docs/a.md', { content: 'unrelated text', rank: 1 }),
            rc('docs/b.md', { content: 'hybrid search', rank: 2 }),
        ];
        expect(keywordRecall(retrieved, ['hybrid'], 1)).toEqual({ hits: 0, total: 1 });
        expect(keywordRecall(retrieved, ['hybrid'], 2)).toEqual({ hits: 1, total: 1 });
    });

    it('returns zeroed totals for empty keyword list', () => {
        expect(keywordRecall([rc('docs/a.md')], [], 4)).toEqual({ hits: 0, total: 0 });
    });
});

describe('duplicateChunkRatioAtK', () => {
    it('counts chunks adjacent in the same doc as duplicates', () => {
        const retrieved = [
            rc('docs/a.md', { chunkIndex: 0 }),
            rc('docs/a.md', { chunkIndex: 1 }),
            rc('docs/a.md', { chunkIndex: 3 }),
            rc('docs/b.md', { chunkIndex: 0 }),
        ];
        expect(duplicateChunkRatioAtK(retrieved, 4)).toBe(0.25);
    });

    it('does not count same-doc chunks two or more apart', () => {
        const retrieved = [
            rc('docs/a.md', { chunkIndex: 0 }),
            rc('docs/a.md', { chunkIndex: 2 }),
        ];
        expect(duplicateChunkRatioAtK(retrieved, 2)).toBe(0);
    });

    it('skips chunks without a chunkIndex', () => {
        const retrieved = [
            rc('docs/a.md', { chunkIndex: undefined }),
            rc('docs/a.md', { chunkIndex: undefined }),
        ];
        expect(duplicateChunkRatioAtK(retrieved, 2)).toBe(0);
    });

    it('returns 0 for empty retrieval', () => {
        expect(duplicateChunkRatioAtK([], 4)).toBe(0);
    });
});

describe('uniqueSourceCoverageAtK', () => {
    it('divides unique docPaths by k', () => {
        const retrieved = [
            rc('docs/a.md'),
            rc('docs/b.md'),
            rc('docs/a.md'),
            rc('docs/c.md'),
        ];
        expect(uniqueSourceCoverageAtK(retrieved, 4)).toBe(0.75);
    });

    it('returns 0 for non-positive k', () => {
        expect(uniqueSourceCoverageAtK([rc('docs/a.md')], 0)).toBe(0);
    });
});

describe('generationContextQualityAtK', () => {
    it('combines source precision, keyword recall and non-duplication', () => {
        // sourcePrecision = 1/2, keywordRecall = 1, dupRatio = 0
        // harmonicMean(0.5, 1) = 2/3
        const retrieved = [
            rc('docs/a.md', { content: 'alpha beta', chunkIndex: 0 }),
            rc('docs/other.md', { content: 'alpha gamma', chunkIndex: 5 }),
        ];
        const query: GoldenQuery = { ...golden, expectedKeywords: ['alpha'] };
        expect(generationContextQualityAtK(retrieved, query, 2)).toBeCloseTo(2 / 3, 10);
    });

    it('returns 0 for unanswerable queries', () => {
        const query: GoldenQuery = { ...golden, answerable: false };
        expect(generationContextQualityAtK([rc('docs/a.md')], query, 4)).toBe(0);
    });

    it('returns 0 for empty retrieval', () => {
        expect(generationContextQualityAtK([], golden, 4)).toBe(0);
    });
});

describe('evaluateQuery', () => {
    const config: EvalConfig = {
        fetchK: 20,
        topK: 4,
        hitRateKs: [4],
        ndcgKs: [4],
        retrievalStrategy: 'baseline-dense',
        mmr: { enabled: false, lambda: 0.9 },
        abstentionThreshold: 0.78,
    };

    const answerableRetrieved: RetrievedChunk[] = [
        rc('docs/a.md', { score: 0.9, content: 'hybrid search config', rank: 1 }),
        rc('docs/x.md', { score: 0.85, rank: 2 }),
    ];

    it('computes all metric maps for answerable queries', () => {
        const result = evaluateQuery(golden, answerableRetrieved, config);
        expect(result.hitAtK[4]).toBe(true);
        expect(result.precisionAtK[4]).toBe(0.25);
        expect(result.reciprocalRank).toBe(1);
        const expectedNdcg = 1 / (1 + 1 / Math.log2(3) + 0.5 + 1 / Math.log2(5));
        expect(result.ndcgAtK[4]).toBeCloseTo(expectedNdcg, 10);
        expect(result.keywordHits).toBe(1);
        expect(result.keywordTotal).toBe(1);
        expect(result.abstentionCorrect).toBe(false);
        expect(result.topScore).toBe(0.9);
    });

    it('flags unanswerable queries via the abstention threshold', () => {
        const query: GoldenQuery = { ...golden, answerable: false };
        const lowScore = [rc('docs/x.md', { score: 0.6 })];
        const highScore = [rc('docs/x.md', { score: 0.9 })];

        expect(evaluateQuery(query, lowScore, config).abstentionCorrect).toBe(true);
        expect(evaluateQuery(query, highScore, config).abstentionCorrect).toBe(false);
    });

    it('zeroes ranking metrics for unanswerable queries but keeps ratio maps', () => {
        const query: GoldenQuery = { ...golden, answerable: false };
        const retrieved = [rc('docs/a.md', { score: 0.6 }), rc('docs/a.md', { chunkIndex: 1, score: 0.5 })];
        const result = evaluateQuery(query, retrieved, config);

        expect(result.hitAtK[4]).toBe(false);
        expect(result.precisionAtK[4]).toBe(0);
        expect(result.reciprocalRank).toBe(0);
        expect(result.ndcgAtK[4]).toBe(0);
        expect(result.duplicateChunkRatioAtK[4]).toBe(0.5);
        expect(result.generationContextQualityAtK[4]).toBe(0);
        expect(result.topScore).toBe(0.6);
    });

    it('lets topScoreOverride win over retrieved scores', () => {
        const query: GoldenQuery = { ...golden, answerable: false };
        const result = evaluateQuery(query, [rc('docs/x.md', { score: 0.95 })], {
            ...config,
            topScoreOverride: 0.6,
        });
        expect(result.topScore).toBe(0.6);
        expect(result.abstentionCorrect).toBe(true);
    });
});

describe('mean', () => {
    it('averages values', () => {
        expect(mean([1, 2, 3])).toBe(2);
    });

    it('returns 0 for empty input', () => {
        expect(mean([])).toBe(0);
    });
});
