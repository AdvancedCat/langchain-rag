import { describe, it, expect, afterEach } from 'vitest';
import { getRetrievalConfig, DEFAULT_ABSTENTION_THRESHOLD } from './config.js';

afterEach(() => {
    delete process.env.RETRIEVAL_ABSTENTION_THRESHOLD;
});

describe('getRetrievalConfig abstentionThreshold', () => {
    it('defaults to 0.78 when the env var is unset', () => {
        delete process.env.RETRIEVAL_ABSTENTION_THRESHOLD;
        expect(DEFAULT_ABSTENTION_THRESHOLD).toBe(0.78);
        expect(getRetrievalConfig().abstentionThreshold).toBe(0.78);
    });

    it('reads RETRIEVAL_ABSTENTION_THRESHOLD from the environment', () => {
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = '0.6';
        expect(getRetrievalConfig().abstentionThreshold).toBe(0.6);
    });

    it('accepts the boundary values 0 and 1', () => {
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = '0';
        expect(getRetrievalConfig().abstentionThreshold).toBe(0);
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = '1';
        expect(getRetrievalConfig().abstentionThreshold).toBe(1);
    });

    it('rejects values outside [0, 1]', () => {
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = '1.5';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_ABSTENTION_THRESHOLD/);
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = '-0.1';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_ABSTENTION_THRESHOLD/);
    });

    it('rejects non-numeric values', () => {
        process.env.RETRIEVAL_ABSTENTION_THRESHOLD = 'high';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_ABSTENTION_THRESHOLD/);
    });
});
