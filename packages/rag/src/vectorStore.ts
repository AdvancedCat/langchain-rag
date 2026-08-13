import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import type { MemoryVector, SerializedVectorStore } from './config.js';
import { getEmbeddingConfig, createEmbeddings } from './embeddings.js';

export function saveVectorStore(
    vectorStore: MemoryVectorStore,
    docPaths: string[],
    filePath: string,
): void {
    const config = getEmbeddingConfig();
    const serialized: SerializedVectorStore = {
        version: 1,
        embeddingModel: config.model,
        embeddingDimensions: config.dimensions,
        docPaths,
        vectors: (vectorStore as any).memoryVectors as MemoryVector[],
        createdAt: new Date().toISOString(),
    };

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(serialized, null, 2), 'utf-8');

    const sizeMB = (
        Buffer.byteLength(JSON.stringify(serialized)) /
        1024 /
        1024
    ).toFixed(2);
    console.log(
        `💾 Saved ${serialized.vectors.length} vectors to ${filePath} (${sizeMB} MB)`,
    );
}

export async function loadVectorStore(
    filePath: string,
): Promise<MemoryVectorStore | null> {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as SerializedVectorStore;
        const config = getEmbeddingConfig();

        if (data.embeddingModel !== config.model) {
            console.warn(
                `⚠️  Embedding model mismatch: saved="${data.embeddingModel}", current="${config.model}". Rebuilding...`,
            );
            return null;
        }

        if (data.embeddingDimensions !== config.dimensions) {
            console.warn(
                `⚠️  Embedding dimensions mismatch: saved=${data.embeddingDimensions}, current=${config.dimensions}. Rebuilding...`,
            );
            return null;
        }

        const embeddings = createEmbeddings();
        const vectorStore = new MemoryVectorStore(embeddings);

        (vectorStore as any).memoryVectors = data.vectors;

        console.log(
            `✅ Loaded ${data.vectors.length} vectors from ${filePath} (indexed at ${data.createdAt})`,
        );
        return vectorStore;
    } catch (error) {
        console.warn(
            `⚠️  Failed to load vector store:`,
            error instanceof Error ? error.message : error,
        );
        return null;
    }
}
