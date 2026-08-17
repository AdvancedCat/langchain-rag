import { describe, it, expect } from 'vitest';
import type { DocumentInterface } from '@langchain/core/documents';
import {
    tokenize,
    BM25Retriever,
    getGlobalBM25Retriever,
    resetGlobalBM25Retriever,
} from './bm25.js';

function doc(pageContent: string): DocumentInterface {
    return { pageContent, metadata: { docPath: 'test.md', chunkIndex: 0 } };
}

describe('tokenize', () => {
    it('lowercases plain english words', () => {
        expect(tokenize('Vector Store Hybrid')).toEqual(['vector', 'store', 'hybrid']);
    });

    it('emits one token per CJK character', () => {
        expect(tokenize('向量数据库')).toEqual(['向', '量', '数', '据', '库']);
    });

    it('mixes CJK and english in one string', () => {
        expect(tokenize('如何配置ragAgent')).toEqual(['如', '何', '配', '置', 'rag', 'agent']);
    });

    it('splits snake_case and kebab-case into parts', () => {
        expect(tokenize('score_threshold maximal-marginal')).toEqual([
            'score',
            'threshold',
            'maximal',
            'marginal',
        ]);
    });

    it('splits camelCase at lowercase-to-uppercase boundaries', () => {
        expect(tokenize('getChunkId')).toEqual(['get', 'chunk', 'id']);
    });

    it('keeps leading letters glued to digits within a word', () => {
        expect(tokenize('v1.2 and 404')).toEqual(['v1', '2', 'and', '404']);
    });

    it('splits all-caps acronyms into single characters (current behavior)', () => {
        expect(tokenize('RAG')).toEqual(['r', 'a', 'g']);
    });

    it('returns an empty array for punctuation-only input', () => {
        expect(tokenize('!!! ... ???')).toEqual([]);
    });
});

describe('BM25Retriever', () => {
    // Corpus engineered for hand-checkable scores:
    //   d1: "apple banana"            len 2, apple:1 banana:1
    //   d2: "apple apple cherry"      len 3, apple:2 cherry:1
    //   d3: "banana cherry cherry"    len 3, banana:1 cherry:2
    // N = 3, avgDocLength = 8/3, k1 = 1.5, b = 0.75
    const corpus = [doc('apple banana'), doc('apple apple cherry'), doc('banana cherry cherry')];

    it('throws when retrieving before build()', () => {
        const retriever = new BM25Retriever();
        expect(() => retriever.retrieve('apple', 3)).toThrow(/not built/i);
        expect(retriever.isBuilt()).toBe(false);
    });

    it('build() on empty corpus yields no results and no throw', () => {
        const retriever = new BM25Retriever();
        retriever.build([]);
        expect(retriever.isBuilt()).toBe(true);
        expect(retriever.size()).toBe(0);
        expect(retriever.retrieve('apple', 3)).toEqual([]);
    });

    it('returns [] when no document matches the query', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);
        expect(retriever.retrieve('zzz', 3)).toEqual([]);
    });

    it('returns [] when the query tokenizes to nothing', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);
        expect(retriever.retrieve('??? !!!', 3)).toEqual([]);
    });

    it('ranks by exact BM25 score (k1=1.5, b=0.75)', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);

        // query "cherry": df=2, idf=ln((3-2+0.5)/(2+0.5)+1)=ln(1.6)
        // d3: tf=2, len 3  -> tfNorm = 5/3.640625  -> score ≈ 0.6454985
        // d2: tf=1, len 3  -> tfNorm = 2.5/2.640625 -> score ≈ 0.4449739
        const results = retriever.retrieve('cherry', 3);
        expect(results.map((r) => r.document.pageContent)).toEqual([
            'banana cherry cherry',
            'apple apple cherry',
        ]);
        expect(results[0].score).toBeCloseTo(0.6454985, 5);
        expect(results[1].score).toBeCloseTo(0.4449739, 5);
    });

    it('higher term frequency beats single occurrence despite longer doc', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);

        // query "apple": d2 (tf=2, len 3) ≈ 0.6454985 > d1 (tf=1, len 2) ≈ 0.5295816
        const results = retriever.retrieve('apple', 3);
        expect(results.map((r) => r.document.pageContent)).toEqual([
            'apple apple cherry',
            'apple banana',
        ]);
        expect(results[1].score).toBeCloseTo(0.5295816, 5);
    });

    it('respects the k limit', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);
        expect(retriever.retrieve('apple banana cherry', 2)).toHaveLength(2);
    });

    it('marks results as sparse retrieval source', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);
        const results = retriever.retrieve('cherry', 3);
        for (const r of results) {
            expect(r.retrievalSource).toBe('sparse');
        }
    });

    it('rebuilding replaces the previous corpus', () => {
        const retriever = new BM25Retriever();
        retriever.build(corpus);
        retriever.build([doc('totally different vocabulary')]);
        expect(retriever.size()).toBe(1);
        expect(retriever.retrieve('apple', 3)).toEqual([]);
    });

    it('global singleton persists until reset', () => {
        const first = getGlobalBM25Retriever();
        expect(getGlobalBM25Retriever()).toBe(first);
        resetGlobalBM25Retriever();
        expect(getGlobalBM25Retriever()).not.toBe(first);
    });
});
