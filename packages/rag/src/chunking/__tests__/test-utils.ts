import { CHUNKER_VERSION } from '../version.js';
import type { Chunk, ChunkMetadata } from '../types.js';

/** 测试专用：构造满足契约的最小 Chunk */
export function makeChunk(
    overrides: {
        id?: string;
        content?: string;
        metadata?: Partial<ChunkMetadata>;
    } = {},
): Chunk {
    const metadata: ChunkMetadata = {
        docId: 'https://docs.langchain.com/oss/javascript/langchain/agents',
        contentHash: 'b'.repeat(64),
        source: 'https://docs.langchain.com/oss/javascript/langchain/agents',
        docType: 'markdown',
        chunkIndex: 0,
        totalChunks: 1,
        chunkerVersion: CHUNKER_VERSION,
        ...overrides.metadata,
    };
    return {
        id: overrides.id ?? 'a'.repeat(64),
        content: overrides.content ?? 'some content',
        metadata,
    };
}
