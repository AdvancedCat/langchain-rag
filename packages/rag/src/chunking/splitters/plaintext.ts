import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { SplitOptions, Splitter, SplitterChunk, SplitDocInput, SplitWarning } from '../types.js';

/** 兜底切分：字符级递归切，无语义结构 */
export class PlaintextSplitter implements Splitter {
    readonly docType = 'plaintext' as const;

    async split(
        input: SplitDocInput,
        options: SplitOptions,
    ): Promise<{ chunks: SplitterChunk[]; warnings: SplitWarning[] }> {
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: options.chunkSize,
            chunkOverlap: options.chunkOverlap,
        });
        const texts = await splitter.splitText(input.text);
        const chunks: SplitterChunk[] = texts
            .filter((text) => text.trim().length > 0)
            .map((content) => ({ content, metadata: {} }));
        return { chunks, warnings: [] as SplitWarning[] };
    }
}
