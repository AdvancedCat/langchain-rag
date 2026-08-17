import { describe, it, expect } from 'vitest';
import type { ScoredChunk } from './types.js';
import {
    deduplicateMerge,
    applyBM25Boost,
    maximalMarginalRelevanceCustom,
    cosineSimilarity,
} from './pipeline.js';

function chunk(
    docPath: string,
    chunkIndex: number,
    score: number,
    overrides: Partial<ScoredChunk> = {},
): ScoredChunk {
    return {
        document: {
            pageContent: `content of ${docPath}#${chunkIndex}`,
            metadata: { docPath, chunkIndex },
        },
        score,
        retrievalSource: 'dense',
        ...overrides,
    };
}

function ids(chunks: ScoredChunk[]): string[] {
    return chunks.map((c) => `${c.document.metadata.docPath}#${c.document.metadata.chunkIndex}`);
}

describe('deduplicateMerge', () => {
    it('merges by chunk id keeping the best score, sorted descending', () => {
        const merged = deduplicateMerge([
            [chunk('a', 0, 0.9), chunk('b', 0, 0.8)],
            [chunk('a', 0, 0.95), chunk('c', 0, 0.7)],
        ]);
        expect(ids(merged)).toEqual(['a#0', 'b#0', 'c#0']);
        expect(merged.map((c) => c.score)).toEqual([0.95, 0.8, 0.7]);
    });

    it('normalizes merged chunks to dense source with denseScore set', () => {
        const merged = deduplicateMerge([[chunk('a', 0, 0.9)]]);
        expect(merged[0].retrievalSource).toBe('dense');
        expect(merged[0].denseScore).toBe(0.9);
    });

    it('returns [] for empty input', () => {
        expect(deduplicateMerge([[], []])).toEqual([]);
    });
});

describe('applyBM25Boost', () => {
    it('returns [] for empty dense candidates', () => {
        expect(applyBM25Boost([], [chunk('x', 0, 5)], 0.2)).toEqual([]);
    });

    it('applies only the dense share when sparse hits no dense candidate', () => {
        // dense range 0.8..0.9 -> a normalized to 1, b to 0; boostWeight 0.2
        const boosted = applyBM25Boost(
            [chunk('a', 0, 0.9), chunk('b', 0, 0.8)],
            [chunk('z', 0, 5)],
            0.2,
        );
        expect(ids(boosted)).toEqual(['a#0', 'b#0']);
        expect(boosted[0].score).toBeCloseTo(0.8, 10);
        expect(boosted[1].score).toBeCloseTo(0, 10);
        expect(boosted[0].retrievalSource).toBe('hybrid');
    });

    it('can reorder when sparse strongly favors a trailing dense candidate', () => {
        // sparse: a=1, b=5 -> min-max gives a:0, b:1; dense gives a:1, b:0
        // boostWeight 0.6 -> a = 0.4, b = 0.6
        const boosted = applyBM25Boost(
            [chunk('a', 0, 1.0), chunk('b', 0, 0.5)],
            [chunk('a', 0, 1), chunk('b', 0, 5)],
            0.6,
        );
        expect(ids(boosted)).toEqual(['b#0', 'a#0']);
        expect(boosted[0].score).toBeCloseTo(0.6, 10);
        expect(boosted[1].score).toBeCloseTo(0.4, 10);
    });

    it('never introduces documents outside the dense candidates', () => {
        const dense = [chunk('a', 0, 0.9), chunk('b', 0, 0.8)];
        const boosted = applyBM25Boost(dense, [chunk('z', 0, 9), chunk('a', 0, 1)], 0.5);
        expect(ids(boosted).sort()).toEqual(['a#0', 'b#0']);
        expect(boosted).toHaveLength(dense.length);
    });

    it('grants zero boost when only one candidate has a sparse score', () => {
        // min-max normalization over a single relevant sparse score yields 0
        const boosted = applyBM25Boost(
            [chunk('a', 0, 0.9), chunk('b', 0, 0.8)],
            [chunk('b', 0, 5)],
            0.2,
        );
        expect(ids(boosted)).toEqual(['a#0', 'b#0']);
        expect(boosted[1].score).toBeCloseTo(0, 10);
    });

    it('normalizes by denseScore rather than the fused score when both exist', () => {
        const boosted = applyBM25Boost(
            [chunk('a', 0, 0.99, { denseScore: 0.85 }), chunk('b', 0, 0.01, { denseScore: 0.9 })],
            [],
            0.2,
        );
        expect(ids(boosted)).toEqual(['b#0', 'a#0']);
    });
});

describe('maximalMarginalRelevanceCustom', () => {
    it('returns [] for no candidates', () => {
        expect(maximalMarginalRelevanceCustom([1, 0], [], [], 0.5, 4)).toEqual([]);
    });

    it('returns all indices when topK >= n', () => {
        expect(maximalMarginalRelevanceCustom([1, 0], [[1, 0], [0, 1]], [0.9, 0.5], 0.5, 2)).toEqual(
            [0, 1],
        );
    });

    it('lambda=1 ranks purely by relevance', () => {
        const relevance = [0.2, 0.9, 0.5];
        const embeddings = [[1, 0], [0, 1], [1, 1]];
        expect(maximalMarginalRelevanceCustom([1, 0], embeddings, relevance, 1, 2)).toEqual([1, 2]);
    });

    it('lambda=0.5 skips a near-duplicate in favor of a diverse candidate', () => {
        // A duplicates the query (relevance 1.0), B duplicates A (relevance 0.9),
        // C is orthogonal (relevance 0.8)
        const query = [1, 0];
        const embeddings = [[1, 0], [1, 0], [0, 1]];
        const relevance = [1.0, 0.9, 0.8];

        expect(maximalMarginalRelevanceCustom(query, embeddings, relevance, 0.5, 2)).toEqual([0, 2]);
        expect(maximalMarginalRelevanceCustom(query, embeddings, relevance, 1, 2)).toEqual([0, 1]);
    });
});

describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
        expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    });

    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    });

    it('computes a known value', () => {
        expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96, 10);
    });

    it('returns 0 for a zero vector instead of NaN', () => {
        expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });
});
