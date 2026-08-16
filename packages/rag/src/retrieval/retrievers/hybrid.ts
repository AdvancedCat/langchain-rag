import type { ScoredChunk } from '../types.js';
import { getChunkId } from '../types.js';

export interface RRFOptions {
    k?: number;
    sourceWeights?: Record<string, number>;
}

export function reciprocalRankFusion(
    resultLists: Array<{ results: ScoredChunk[]; weight?: number }>,
    options: RRFOptions = {},
): ScoredChunk[] {
    const k = options.k ?? 60;

    const docMap = new Map<
        string,
        {
            document: ScoredChunk['document'];
            rrfScore: number;
            bestDenseScore: number;
        }
    >();

    for (const { results, weight = 1 } of resultLists) {
        for (let i = 0; i < results.length; i++) {
            const chunk = results[i];
            const docId = getChunkId(chunk);
            const rank = i + 1;
            const rrfIncrement = weight / (k + rank);

            const chunkDenseScore =
                chunk.denseScore ??
                (chunk.retrievalSource === 'dense' ? chunk.score : 0);

            const existing = docMap.get(docId);
            if (existing) {
                existing.rrfScore += rrfIncrement;
                if (chunkDenseScore > existing.bestDenseScore) {
                    existing.bestDenseScore = chunkDenseScore;
                }
            } else {
                docMap.set(docId, {
                    document: chunk.document,
                    rrfScore: rrfIncrement,
                    bestDenseScore: chunkDenseScore,
                });
            }
        }
    }

    const fused: ScoredChunk[] = Array.from(docMap.values()).map(
        ({ document, rrfScore, bestDenseScore }) => ({
            document,
            score: rrfScore,
            retrievalSource: 'hybrid',
            denseScore: bestDenseScore > 0 ? bestDenseScore : undefined,
        }),
    );

    fused.sort((a, b) => b.score - a.score);
    return fused;
}

export function deduplicate(chunks: ScoredChunk[]): ScoredChunk[] {
    const seen = new Set<string>();
    const result: ScoredChunk[] = [];
    for (const chunk of chunks) {
        const id = getChunkId(chunk);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(chunk);
        }
    }
    return result;
}
