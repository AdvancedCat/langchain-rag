import { describe, it, expect } from 'vitest';
import { contentHash, chunkId, toDeterministicUuid } from '../ids.js';

describe('contentHash', () => {
    it('is deterministic for identical input', () => {
        expect(contentHash('# Title\nbody')).toBe(contentHash('# Title\nbody'));
    });

    it('produces sha256 hex (64 chars) and differs across inputs', () => {
        const a = contentHash('a');
        const b = contentHash('b');
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).not.toBe(b);
    });
});

describe('chunkId', () => {
    it('is deterministic for the same (docId, chunkIndex, content)', () => {
        expect(chunkId('https://x.test/doc', 0, 'c')).toBe(chunkId('https://x.test/doc', 0, 'c'));
    });

    it('varies with docId, chunkIndex and content independently', () => {
        const base = chunkId('doc', 0, 'c');
        expect(chunkId('other', 0, 'c')).not.toBe(base);
        expect(chunkId('doc', 1, 'c')).not.toBe(base);
        expect(chunkId('doc', 0, 'other')).not.toBe(base);
    });
});

describe('toDeterministicUuid', () => {
    it('formats a 64-hex digest into a UUID shape', () => {
        const hash = 'a'.repeat(64);
        expect(toDeterministicUuid(hash)).toBe(
            `${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`,
        );
    });

    it('re-hashes non-sha256 input and stays deterministic', () => {
        const once = toDeterministicUuid('not-a-hash');
        const twice = toDeterministicUuid('not-a-hash');
        expect(once).toBe(twice);
        expect(once).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });
});
