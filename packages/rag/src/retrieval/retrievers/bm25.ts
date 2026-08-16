import type { DocumentInterface } from '@langchain/core/documents';
import type { ScoredChunk } from '../types.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface IndexedDoc {
    document: DocumentInterface;
    docLength: number;
    termFreq: Map<string, number>;
}

function splitCamelCase(word: string): string[] {
    const parts: string[] = [];
    let current = '';
    for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        if (/[A-Z]/.test(ch) && current.length > 0 && /[a-z]/.test(current[current.length - 1])) {
            parts.push(current.toLowerCase());
            current = ch.toLowerCase();
        } else {
            current += ch.toLowerCase();
        }
    }
    if (current) parts.push(current.toLowerCase());
    return parts;
}

export function tokenize(text: string): string[] {
    const tokens: string[] = [];

    const regex = /[a-zA-Z_][a-zA-Z0-9_-]*|\d+|[\u4e00-\u9fff]/g;
    let match: RegExpExecArray | null;

    const re = new RegExp(regex.source, 'g');
    while ((match = re.exec(text)) !== null) {
        const raw = match[0];

        if (/[\u4e00-\u9fff]/.test(raw)) {
            tokens.push(raw);
            continue;
        }

        if (/^\d+$/.test(raw)) {
            tokens.push(raw);
            continue;
        }

        const subParts = raw.split(/[_-]+/).filter((p) => p.length > 0);
        for (const part of subParts) {
            const camelParts = splitCamelCase(part);
            for (const cp of camelParts) {
                if (cp.length > 0) {
                    tokens.push(cp);
                }
            }
        }
    }

    return tokens;
}

export class BM25Retriever {
    private docs: IndexedDoc[] = [];
    private docFreq: Map<string, number> = new Map();
    private avgDocLength = 0;
    private corpusSize = 0;
    private built = false;

    build(documents: DocumentInterface[]): void {
        this.docs = [];
        this.docFreq.clear();
        this.corpusSize = documents.length;

        if (documents.length === 0) {
            this.avgDocLength = 0;
            this.built = true;
            return;
        }

        let totalLength = 0;

        for (const doc of documents) {
            const tokens = tokenize(doc.pageContent);
            const termFreq = new Map<string, number>();
            for (const token of tokens) {
                termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
            }

            for (const [term] of termFreq) {
                this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
            }

            this.docs.push({
                document: doc,
                docLength: tokens.length,
                termFreq,
            });
            totalLength += tokens.length;
        }

        this.avgDocLength = totalLength / this.corpusSize;
        this.built = true;
    }

    retrieve(query: string, k: number): ScoredChunk[] {
        if (!this.built) {
            throw new Error('BM25 index not built. Call build() first.');
        }
        if (this.docs.length === 0) {
            return [];
        }

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) {
            return [];
        }

        const scores: Array<{ index: number; score: number }> = [];

        for (let i = 0; i < this.docs.length; i++) {
            const doc = this.docs[i];
            let score = 0;

            for (const term of queryTokens) {
                const df = this.docFreq.get(term);
                if (!df) continue;

                const tf = doc.termFreq.get(term) ?? 0;
                if (tf === 0) continue;

                const idf = Math.log(
                    (this.corpusSize - df + 0.5) / (df + 0.5) + 1,
                );

                const tfNorm =
                    (tf * (BM25_K1 + 1)) /
                    (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.docLength / this.avgDocLength)));

                score += idf * tfNorm;
            }

            if (score > 0) {
                scores.push({ index: i, score });
            }
        }

        scores.sort((a, b) => b.score - a.score);

        return scores.slice(0, k).map(({ index, score }) => ({
            document: this.docs[index].document,
            score,
            retrievalSource: 'sparse' as const,
        }));
    }

    size(): number {
        return this.docs.length;
    }

    isBuilt(): boolean {
        return this.built;
    }
}

let globalBM25Retriever: BM25Retriever | null = null;

export function getGlobalBM25Retriever(): BM25Retriever {
    if (!globalBM25Retriever) {
        globalBM25Retriever = new BM25Retriever();
    }
    return globalBM25Retriever;
}

export function resetGlobalBM25Retriever(): void {
    globalBM25Retriever = null;
}
