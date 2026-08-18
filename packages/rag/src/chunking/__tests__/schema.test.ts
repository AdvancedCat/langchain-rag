import { describe, it, expect } from 'vitest';
import { ChunkSchema, ChunkMetadataSchema, SplitResultSchema } from '../schema.js';
import { makeChunk } from './test-utils.js';

describe('ChunkMetadataSchema', () => {
    it('accepts a minimal valid metadata and allows unknown fields to pass through', () => {
        const result = ChunkMetadataSchema.safeParse({
            ...makeChunk().metadata,
            indexedAt: '2026-08-18T00:00:00.000Z',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.indexedAt).toBe('2026-08-18T00:00:00.000Z');
        }
    });

    it('rejects missing required fields', () => {
        const { docId, ...withoutDocId } = makeChunk().metadata;
        void docId;
        expect(ChunkMetadataSchema.safeParse(withoutDocId).success).toBe(false);
    });

    it('rejects unknown docType and negative chunkIndex', () => {
        expect(
            ChunkMetadataSchema.safeParse({ ...makeChunk().metadata, docType: 'docx' }).success,
        ).toBe(false);
        expect(
            ChunkMetadataSchema.safeParse({ ...makeChunk().metadata, chunkIndex: -1 }).success,
        ).toBe(false);
    });

    it('validates sectionPath as a non-empty string array', () => {
        expect(
            ChunkMetadataSchema.safeParse({
                ...makeChunk().metadata,
                sectionPath: ['Agents', 'Tools'],
            }).success,
        ).toBe(true);
        expect(
            ChunkMetadataSchema.safeParse({
                ...makeChunk().metadata,
                sectionPath: ['Agents', ''],
            }).success,
        ).toBe(false);
    });
});

describe('ChunkSchema', () => {
    it('requires non-empty id and content', () => {
        expect(ChunkSchema.safeParse(makeChunk()).success).toBe(true);
        expect(ChunkSchema.safeParse(makeChunk({ id: '' })).success).toBe(false);
        expect(ChunkSchema.safeParse(makeChunk({ content: '' })).success).toBe(false);
    });
});

describe('SplitResultSchema', () => {
    it('accepts a pipeline-shaped result', () => {
        const result = SplitResultSchema.safeParse({
            chunks: [makeChunk()],
            warnings: [{ code: 'x', message: 'y' }],
            docType: 'markdown',
        });
        expect(result.success).toBe(true);
    });

    it('rejects an invalid docType', () => {
        expect(
            SplitResultSchema.safeParse({
                chunks: [],
                warnings: [],
                docType: 'unknown',
            }).success,
        ).toBe(false);
    });
});
