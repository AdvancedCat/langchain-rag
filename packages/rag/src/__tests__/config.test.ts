import { describe, it, expect, afterEach } from 'vitest';
import {
    getRetrievalConfig,
    getIngestionConfig,
    DEFAULT_ABSTENTION_THRESHOLD,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_RERANK_GATE_THRESHOLD,
} from '../config.js';

afterEach(() => {
    delete process.env.RETRIEVAL_ABSTENTION_THRESHOLD;
    delete process.env.RETRIEVAL_RERANK_GATE_ENABLED;
    delete process.env.RETRIEVAL_RERANK_GATE_THRESHOLD;
    delete process.env.RETRIEVAL_MMR_ENABLED;
    delete process.env.CHUNK_SIZE;
    delete process.env.CHUNK_OVERLAP;
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

describe('getRetrievalConfig rerankGate', () => {
    it('defaults to enabled with the calibrated threshold', () => {
        expect(DEFAULT_RERANK_GATE_THRESHOLD).toBe(0.52);
        expect(getRetrievalConfig().rerankGate).toEqual({
            enabled: true,
            threshold: 0.52,
        });
    });

    it('reads RETRIEVAL_RERANK_GATE_* from the environment', () => {
        process.env.RETRIEVAL_RERANK_GATE_ENABLED = 'false';
        process.env.RETRIEVAL_RERANK_GATE_THRESHOLD = '0.4';
        expect(getRetrievalConfig().rerankGate).toEqual({
            enabled: false,
            threshold: 0.4,
        });
    });

    it('rejects values outside [0, 1]', () => {
        process.env.RETRIEVAL_RERANK_GATE_THRESHOLD = '1.2';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_RERANK_GATE_THRESHOLD/);
        process.env.RETRIEVAL_RERANK_GATE_THRESHOLD = '-0.1';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_RERANK_GATE_THRESHOLD/);
    });

    it('rejects gate + MMR both enabled (MMR starves the fetchK gate pool)', () => {
        process.env.RETRIEVAL_MMR_ENABLED = 'true';
        expect(() => getRetrievalConfig()).toThrow(/RETRIEVAL_RERANK_GATE_ENABLED/);
    });
});

describe('getIngestionConfig', () => {
    it('defaults to chunkSize 1000 / chunkOverlap 200 / maxHeaderDepth 2', () => {
        expect(getIngestionConfig()).toEqual({
            chunkSize: DEFAULT_CHUNK_SIZE,
            chunkOverlap: DEFAULT_CHUNK_OVERLAP,
            maxHeaderDepth: 2,
        });
    });

    it('reads CHUNK_SIZE and CHUNK_OVERLAP from the environment', () => {
        process.env.CHUNK_SIZE = '800';
        process.env.CHUNK_OVERLAP = '100';
        expect(getIngestionConfig()).toEqual({
            chunkSize: 800,
            chunkOverlap: 100,
            maxHeaderDepth: 2,
        });
    });

    it('rejects overlap >= size', () => {
        process.env.CHUNK_SIZE = '500';
        process.env.CHUNK_OVERLAP = '500';
        expect(() => getIngestionConfig()).toThrow(/CHUNK_OVERLAP/);
    });

    it('rejects non-positive integers', () => {
        process.env.CHUNK_SIZE = '0';
        expect(() => getIngestionConfig()).toThrow(/CHUNK_SIZE/);
    });
});

describe('getIngestionConfig maxHeaderDepth', () => {
    it('defaults to 2 and reads INGESTION_MAX_HEADER_DEPTH', () => {
        expect(getIngestionConfig().maxHeaderDepth).toBe(2);
        process.env.INGESTION_MAX_HEADER_DEPTH = '4';
        expect(getIngestionConfig().maxHeaderDepth).toBe(4);
        delete process.env.INGESTION_MAX_HEADER_DEPTH;
    });

    it('rejects out-of-range depths', () => {
        process.env.INGESTION_MAX_HEADER_DEPTH = '7';
        expect(() => getIngestionConfig()).toThrow(/INGESTION_MAX_HEADER_DEPTH/);
    });
});
