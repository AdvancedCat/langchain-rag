import type { DocumentInterface } from '@langchain/core/documents';

export type RetrievalSourceType = 'dense' | 'sparse' | 'hybrid';

export interface ScoredChunk {
    document: DocumentInterface;
    score: number;
    retrievalSource: RetrievalSourceType;
    denseScore?: number;
    rerankScore?: number;
}

export function getChunkId(chunk: Pick<ScoredChunk, 'document'>): string {
    const docPath = chunk.document.metadata?.docPath ?? 'unknown';
    const chunkIndex = chunk.document.metadata?.chunkIndex ?? '?';
    return `${docPath}#${chunkIndex}`;
}

export function getMaxDenseScore(chunks: ScoredChunk[]): number {
    let max = 0;
    for (const chunk of chunks) {
        const s = chunk.denseScore ?? (chunk.retrievalSource === 'dense' ? chunk.score : 0);
        if (s > max) max = s;
    }
    return max;
}
