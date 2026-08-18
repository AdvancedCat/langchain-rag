import { describe, it, expect } from 'vitest';
import type { ScoredChunk } from '../../types.js';
import { reciprocalRankFusion, deduplicate } from '../hybrid.js';

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

describe('reciprocalRankFusion', () => {
    it('sums weighted reciprocal ranks across lists and sorts descending', () => {
        // L1 (weight 1): [X, Y]; L2 (weight 5): [X, Z]
        // X = 1/61 + 5/61 = 6/61 ≈ 0.0983607
        // Z = 5/62          ≈ 0.0806452
        // Y = 1/62          ≈ 0.0161290
        const fused = reciprocalRankFusion([
            { results: [chunk('x', 0, 0.9), chunk('y', 0, 0.8)], weight: 1 },
            { results: [chunk('x', 0, 1, { retrievalSource: 'sparse' }), chunk('z', 0, 1, { retrievalSource: 'sparse' })], weight: 5 },
        ]);

        expect(fused.map((c) => c.document.metadata.docPath)).toEqual(['x', 'z', 'y']);
        expect(fused[0].score).toBeCloseTo(6 / 61, 10);
        expect(fused[1].score).toBeCloseTo(5 / 62, 10);
        expect(fused[2].score).toBeCloseTo(1 / 62, 10);
    });

    it('marks fused results as hybrid source', () => {
        const fused = reciprocalRankFusion([{ results: [chunk('x', 0, 0.9)] }]);
        expect(fused[0].retrievalSource).toBe('hybrid');
    });

    it('keeps the best denseScore across all occurrences', () => {
        const fused = reciprocalRankFusion([
            { results: [chunk('x', 0, 0.9)] },
            { results: [chunk('x', 0, 0.7)] },
        ]);
        expect(fused[0].denseScore).toBe(0.9);
    });

    it('leaves denseScore undefined for sparse-only documents', () => {
        const fused = reciprocalRankFusion([
            { results: [chunk('x', 0, 1, { retrievalSource: 'sparse' })] },
        ]);
        expect(fused[0].denseScore).toBeUndefined();
    });

    it('returns [] for empty input', () => {
        expect(reciprocalRankFusion([])).toEqual([]);
        expect(reciprocalRankFusion([{ results: [] }])).toEqual([]);
    });
});

describe('deduplicate', () => {
    it('keeps the first occurrence of each chunk id in order', () => {
        const chunks = [chunk('a', 0, 0.9), chunk('b', 0, 0.8), chunk('a', 0, 0.95), chunk('c', 0, 0.7)];
        const deduped = deduplicate(chunks);
        expect(deduped.map((c) => c.document.metadata.docPath)).toEqual(['a', 'b', 'c']);
        expect(deduped[0].score).toBe(0.9);
    });

    it('treats same docPath with different chunkIndex as distinct chunks', () => {
        const deduped = deduplicate([chunk('a', 0, 0.9), chunk('a', 1, 0.8)]);
        expect(deduped).toHaveLength(2);
    });

    it('returns [] for empty input', () => {
        expect(deduplicate([])).toEqual([]);
    });
});
