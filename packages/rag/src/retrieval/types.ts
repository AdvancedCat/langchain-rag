import type { DocumentInterface } from '@langchain/core/documents';

export interface ScoredChunk {
    document: DocumentInterface;
    score: number;
}
