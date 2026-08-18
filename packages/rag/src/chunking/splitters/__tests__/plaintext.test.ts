import { describe, it, expect } from 'vitest';
import { PlaintextSplitter } from '../plaintext.js';
import type { SplitDocInput, SplitOptions } from '../../types.js';

const OPTIONS: SplitOptions = { chunkSize: 50, chunkOverlap: 5, maxHeaderDepth: 4 };
const INPUT: SplitDocInput = {
    text: 'plain text '.repeat(20),
    docId: 'https://x.test/doc',
    source: 'https://x.test/doc',
};

describe('PlaintextSplitter', () => {
    it('splits long text into chunks within the size budget', async () => {
        const { chunks } = await new PlaintextSplitter().split(INPUT, OPTIONS);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.chunkSize);
        }
    });

    it('returns a single chunk for short text without semantic metadata', async () => {
        const { chunks } = await new PlaintextSplitter().split(
            { ...INPUT, text: 'short' },
            OPTIONS,
        );
        expect(chunks).toEqual([{ content: 'short', metadata: {} }]);
    });

    it('drops whitespace-only pieces', async () => {
        const { chunks } = await new PlaintextSplitter().split(
            { ...INPUT, text: '   \n\t  ' },
            OPTIONS,
        );
        expect(chunks).toEqual([]);
    });
});
