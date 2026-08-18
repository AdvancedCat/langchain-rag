import { describe, it, expect } from 'vitest';
import type { ScoredChunk } from '../types.js';
import { getChunkId, getMaxDenseScore } from '../types.js';

function chunk(overrides: Partial<ScoredChunk>): ScoredChunk {
    return {
        document: { pageContent: 'content', metadata: { docPath: 'a.md', chunkIndex: 0 } },
        score: 0.5,
        retrievalSource: 'dense',
        ...overrides,
    };
}

describe('getChunkId', () => {
    it('combines docPath and chunkIndex from metadata', () => {
        expect(getChunkId(chunk({}))).toBe('a.md#0');
    });

    it('falls back to unknown placeholders for missing metadata', () => {
        const bare = { document: { pageContent: 'x' } } as ScoredChunk;
        expect(getChunkId(bare)).toBe('unknown#?');
    });
});

describe('getMaxDenseScore', () => {
    it('returns 0 for empty input', () => {
        expect(getMaxDenseScore([])).toBe(0);
    });

    it('prefers denseScore over the fused score', () => {
        expect(
            getMaxDenseScore([chunk({ score: 0.9, denseScore: 0.5, retrievalSource: 'hybrid' })]),
        ).toBe(0.5);
    });

    it('falls back to score for dense-source chunks without denseScore', () => {
        expect(getMaxDenseScore([chunk({ score: 0.9, retrievalSource: 'dense' })])).toBe(0.9);
    });

    it('ignores sparse-source chunks without denseScore', () => {
        expect(getMaxDenseScore([chunk({ score: 0.9, retrievalSource: 'sparse' })])).toBe(0);
    });

    it('returns the maximum across a mixed list', () => {
        const chunks = [
            chunk({ score: 0.99, denseScore: 0.6, retrievalSource: 'hybrid' }),
            chunk({ score: 0.7, retrievalSource: 'dense' }),
            chunk({ score: 0.95, retrievalSource: 'sparse' }),
        ];
        expect(getMaxDenseScore(chunks)).toBe(0.7);
    });
});

describe('getChunkId with deterministic chunk ids', () => {
    it('prefers metadata.id when present (new collections)', () => {
        expect(
            getChunkId(chunk({ document: { pageContent: 'x', metadata: { id: 'deadbeef'.repeat(8) } } })),
        ).toBe('deadbeef'.repeat(8));
    });

    it('falls back to docPath#chunkIndex for legacy metadata', () => {
        expect(getChunkId(chunk({}))).toBe('a.md#0');
    });

    it('ignores non-string id values defensively', () => {
        expect(
            getChunkId(chunk({ document: { pageContent: 'x', metadata: { id: 42, docPath: 'b.md', chunkIndex: 3 } } })),
        ).toBe('b.md#3');
    });
});
