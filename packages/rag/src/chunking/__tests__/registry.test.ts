import { describe, it, expect } from 'vitest';
import { SplitterRegistry, createDefaultRegistry } from '../registry.js';
import type { Splitter, SplitterChunk, SplitDocInput, SplitOptions } from '../types.js';

function stubSplitter(docType: Splitter['docType']): Splitter {
    return {
        docType,
        async split(): Promise<{ chunks: SplitterChunk[]; warnings: [] }> {
            return { chunks: [], warnings: [] };
        },
    };
}

describe('SplitterRegistry', () => {
    it('registers and retrieves a splitter by docType', () => {
        const registry = new SplitterRegistry();
        const splitter = stubSplitter('html');
        registry.register(splitter);
        expect(registry.get('html')).toBe(splitter);
        expect(registry.has('html')).toBe(true);
    });

    it('returns undefined for unregistered types', () => {
        const registry = new SplitterRegistry();
        expect(registry.get('pdf')).toBeUndefined();
        expect(registry.has('pdf')).toBe(false);
    });

    it('lists registered docTypes', () => {
        const registry = createDefaultRegistry();
        expect(registry.list().sort()).toEqual(['markdown', 'plaintext']);
    });
});

describe('createDefaultRegistry', () => {
    it('provides markdown and plaintext splitters (D8)', () => {
        const registry = createDefaultRegistry();
        expect(registry.get('markdown')?.docType).toBe('markdown');
        expect(registry.get('plaintext')?.docType).toBe('plaintext');
        expect(registry.get('pdf')).toBeUndefined();
    });
});

describe('default splitters honor the Splitter contract', () => {
    const options: SplitOptions = { chunkSize: 100, chunkOverlap: 10, maxHeaderDepth: 4 };
    const input: SplitDocInput = {
        text: '# T\n\nbody text long enough to be split into pieces by the splitter for sure yes',
        docId: 'https://x.test/doc',
        source: 'https://x.test/doc',
    };

    it('markdown splitter returns ordered chunks with section context', async () => {
        const splitter = createDefaultRegistry().get('markdown')!;
        const { chunks } = await splitter.split(input, options);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0].metadata.sectionPath).toEqual(['T']);
    });

    it('plaintext splitter returns chunks without semantic metadata', async () => {
        const splitter = createDefaultRegistry().get('plaintext')!;
        const { chunks } = await splitter.split(input, options);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0].metadata.sectionPath).toBeUndefined();
    });
});
