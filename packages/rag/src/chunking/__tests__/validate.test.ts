import { describe, it, expect } from 'vitest';
import { validateChunks } from '../validate.js';
import { makeChunk } from './test-utils.js';
import type { Chunk } from '../types.js';

function makeDocumentChunks(count: number, mutate?: (chunk: Chunk, i: number) => void): Chunk[] {
    const chunks = Array.from({ length: count }, (_, i) =>
        makeChunk({
            id: String(i).repeat(64),
            content: `content ${i}`,
            metadata: { chunkIndex: i, totalChunks: count, contentHash: String(i).repeat(64) },
        }),
    );
    chunks.forEach((chunk, i) => mutate?.(chunk, i));
    return chunks;
}

describe('validateChunks hard errors', () => {
    it('accepts a contiguous, consistent document', () => {
        const result = validateChunks(makeDocumentChunks(3), { budgetLimit: 100 });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('rejects schema violations with chunk index context', () => {
        const chunks = makeDocumentChunks(2);
        delete (chunks[1].metadata as Partial<Chunk['metadata']>).docId;
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('chunks[1]');
    });

    it('rejects non-contiguous chunkIndex', () => {
        const chunks = makeDocumentChunks(3, (chunk, i) => {
            if (i === 1) chunk.metadata.chunkIndex = 5;
        });
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/chunkIndex is 5, expected 1/);
    });

    it('rejects mismatched totalChunks', () => {
        const chunks = makeDocumentChunks(2, (chunk) => {
            chunk.metadata.totalChunks = 9;
        });
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/totalChunks is 9/);
    });

    it('rejects mixed docIds', () => {
        const chunks = makeDocumentChunks(2, (chunk, i) => {
            if (i === 1) chunk.metadata.docId = 'https://example.com/other';
        });
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/docId .* differs from chunks\[0\]/);
    });

    it('rejects duplicate ids', () => {
        const chunks = makeDocumentChunks(2);
        chunks[1].id = chunks[0].id;
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/duplicates an earlier chunk/);
    });

    it('rejects empty or whitespace-only content', () => {
        const chunks = makeDocumentChunks(2);
        chunks[1].content = '   \n\t ';
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/content is empty/);
    });

    it('returns valid=true for an empty chunk list', () => {
        expect(validateChunks([], { budgetLimit: 100 })).toEqual({
            valid: true,
            errors: [],
            warnings: [],
        });
    });
});

describe('validateChunks soft warnings', () => {
    it('warns when sectionPath depth skips a level', () => {
        const chunks = makeDocumentChunks(3, (chunk, i) => {
            if (i === 0) chunk.metadata.sectionPath = ['Agents'];
            if (i === 1) chunk.metadata.sectionPath = ['Agents', 'Tools', 'Custom tools'];
            if (i === 2) chunk.metadata.sectionPath = ['Agents'];
        });
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].code).toBe('section-path-depth-skip');
    });

    it('does not warn on normal depth changes', () => {
        const chunks = makeDocumentChunks(3, (chunk, i) => {
            if (i === 0) chunk.metadata.sectionPath = ['Agents', 'Tools'];
            if (i === 1) chunk.metadata.sectionPath = ['Agents', 'Tools', 'Custom tools'];
            if (i === 2) chunk.metadata.sectionPath = ['Agents'];
        });
        const result = validateChunks(chunks, { budgetLimit: 100 });
        expect(result.warnings).toEqual([]);
    });

    it('warns when content exceeds the budget limit', () => {
        const chunks = makeDocumentChunks(1, (chunk) => {
            chunk.content = 'x'.repeat(50);
        });
        const result = validateChunks(chunks, { budgetLimit: 10 });
        expect(result.warnings.map((w) => w.code)).toContain('chunk-over-budget');
        expect(result.valid).toBe(true);
    });
});
