import type { DocumentInterface } from '@langchain/core/documents';

export type RetrievalSourceType = 'dense' | 'sparse' | 'hybrid';

export interface ScoredChunk {
    document: DocumentInterface;
    score: number;
    retrievalSource: RetrievalSourceType;
    denseScore?: number;
    rerankScore?: number;
}

/**
 * chunk 身份（去重/融合 key）：新 collection 优先确定性 chunk id（sha256），
 * 旧 collection（无 id 字段）回退 docPath#chunkIndex。
 */
export function getChunkId(chunk: Pick<ScoredChunk, 'document'>): string {
    const metadata = chunk.document.metadata as Record<string, unknown> | undefined;
    const id = metadata?.id;
    if (typeof id === 'string' && id.length > 0) return id;
    const docPath = metadata?.docPath ?? 'unknown';
    const chunkIndex = metadata?.chunkIndex ?? '?';
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
