import { describe, it, expect } from 'vitest';
import { runChunkingPipeline } from '../pipeline.js';
import { SplitterRegistry } from '../registry.js';
import { PlaintextSplitter } from '../splitters/plaintext.js';
import { chunkId, contentHash } from '../ids.js';
import { CHUNKER_VERSION } from '../version.js';

const DOC = {
    text: '# Agents\n\nIntro.\n\n## Tools\n\nTools body.',
    docId: 'https://docs.langchain.com/agents',
    source: 'https://docs.langchain.com/agents',
    docPath: 'oss/javascript/langchain/agents',
    declaredType: 'markdown' as const,
};

describe('runChunkingPipeline', () => {
    it('detects, splits, stamps deterministic fields and validates', async () => {
        const result = await runChunkingPipeline(DOC);

        expect(result.docType).toBe('markdown');
        expect(result.warnings).toEqual([]);
        expect(result.chunks.map((c) => c.metadata.sectionPath)).toEqual([
            ['Agents'],
            ['Agents', 'Tools'],
        ]);

        for (const [index, chunk] of result.chunks.entries()) {
            expect(chunk.id).toBe(chunkId(DOC.docId, index, chunk.content));
            expect(chunk.metadata).toMatchObject({
                docId: DOC.docId,
                source: DOC.source,
                docPath: DOC.docPath,
                docType: 'markdown',
                contentHash: contentHash(chunk.content),
                chunkIndex: index,
                totalChunks: result.chunks.length,
                chunkerVersion: CHUNKER_VERSION,
                title: 'Agents',
            });
        }
    });

    it('is deterministic across runs (no timestamps or randomness)', async () => {
        const first = await runChunkingPipeline(DOC);
        const second = await runChunkingPipeline(DOC);
        expect(first).toEqual(second);
    });

    it('falls back to plaintext with a warning when no splitter is registered for the detected type', async () => {
        const result = await runChunkingPipeline({
            text: 'plain body text',
            docId: 'https://x.test/f.txt',
            source: 'https://x.test/f.txt',
            declaredType: 'html',
        });
        expect(result.docType).toBe('plaintext');
        expect(result.warnings.map((w) => w.code)).toContain('splitter-not-registered');
        expect(result.chunks[0].metadata.docType).toBe('plaintext');
    });

    it('emits type-detection fallback warning for featureless text', async () => {
        const result = await runChunkingPipeline({
            text: 'nothing recognizable at all',
            docId: 'https://x.test/x',
            source: 'https://x.test/x',
        });
        expect(result.docType).toBe('plaintext');
        expect(result.warnings.map((w) => w.code)).toContain('type-detection-fallback');
    });

    it('passes validator warnings (e.g. over-budget) through without failing', async () => {
        // RecursiveCharacterTextSplitter 逐字符兜底后自身不会超预算，
        // 用 mock splitter 产出超长 chunk 验证 pipeline 透传 validator 软警告
        const registry = new SplitterRegistry();
        registry.register({
            docType: 'markdown',
            async split() {
                return {
                    chunks: [{ content: 'x'.repeat(250), metadata: {} }],
                    warnings: [],
                };
            },
        });
        registry.register(new PlaintextSplitter());

        const result = await runChunkingPipeline(
            { ...DOC, declaredType: undefined },
            { chunkSize: 100, chunkOverlap: 10 },
            registry,
        );
        expect(result.warnings.map((w) => w.code)).toContain('chunk-over-budget');
        expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('rejects chunk schemas that violate the contract (ChunkValidationError)', async () => {
        // docId 缺失 → schema 硬错误
        await expect(
            runChunkingPipeline({ text: '# T\n\nbody', docId: '', source: 's' }),
        ).rejects.toThrow(/validation failed/);
    });
});
