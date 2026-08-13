import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VectorStore } from '@langchain/core/vectorstores';
import type { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { QdrantVectorStore } from '@langchain/qdrant';
import type { QdrantLibArgs } from '@langchain/qdrant';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemoryVector, QdrantConfig, SerializedVectorStore, VectorStoreType } from './config.js';
import { VECTOR_STORE_PATH } from './config.js';
import { getEmbeddingConfig, createEmbeddings } from './embeddings.js';

const DEFAULT_COLLECTION_NAME = 'langchain_docs';
const UPSERT_BATCH_SIZE = 100;

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function getVectorStoreType(): VectorStoreType {
    const type = process.env.VECTOR_STORE_TYPE?.toLowerCase();
    if (type === 'qdrant' || type === 'memory') {
        return type;
    }
    return 'memory';
}

function getQdrantConfig(): QdrantConfig {
    return {
        url: process.env.QDRANT_URL ?? 'http://localhost:6333',
        apiKey: process.env.QDRANT_API_KEY,
        collectionName: process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME,
    };
}

function saveMemoryVectorStore(
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

async function loadMemoryVectorStore(
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

async function checkQdrantCollectionExists(
    client: QdrantClient,
    collectionName: string,
): Promise<boolean> {
    try {
        const collections = await client.getCollections();
        return collections.collections.some((c) => c.name === collectionName);
    } catch {
        return false;
    }
}

async function getQdrantCollectionInfo(client: QdrantClient, collectionName: string) {
    try {
        return await client.getCollection(collectionName);
    } catch {
        return null;
    }
}

async function loadQdrantVectorStore(): Promise<QdrantVectorStore | null> {
    const qdrantConfig = getQdrantConfig();
    const embeddings = createEmbeddings();

    console.log(`🔌 Connecting to Qdrant at ${qdrantConfig.url}...`);

    const client = new QdrantClient({
        url: qdrantConfig.url,
        apiKey: qdrantConfig.apiKey,
    });

    try {
        const collectionExists = await checkQdrantCollectionExists(
            client,
            qdrantConfig.collectionName,
        );

        if (!collectionExists) {
            console.log(
                `📦 Qdrant collection "${qdrantConfig.collectionName}" not found. Will create new index.`,
            );
            return null;
        }

        const collectionInfo = await getQdrantCollectionInfo(
            client,
            qdrantConfig.collectionName,
        );
        const config = getEmbeddingConfig();

        if (collectionInfo && config.dimensions) {
            const vectorSize = collectionInfo.config.params.vectors?.size;
            if (vectorSize && vectorSize !== config.dimensions) {
                console.warn(
                    `⚠️  Qdrant collection vector size mismatch: collection=${vectorSize}, config=${config.dimensions}. Recreating collection...`,
                );
                await client.deleteCollection(qdrantConfig.collectionName);
                return null;
            }
        }

        const pointsCount = collectionInfo?.points_count ?? 0;
        console.log(
            `✅ Loaded Qdrant collection "${qdrantConfig.collectionName}" (${pointsCount} vectors)`,
        );

        return QdrantVectorStore.fromExistingCollection(embeddings, {
            client,
            collectionName: qdrantConfig.collectionName,
        });
    } catch (error) {
        console.warn(
            `⚠️  Failed to connect to Qdrant:`,
            error instanceof Error ? error.message : error,
        );
        console.warn(`⚠️  Falling back to rebuild...`);
        return null;
    }
}

export async function loadVectorStore(
    filePath: string = VECTOR_STORE_PATH,
): Promise<VectorStore | null> {
    const storeType = getVectorStoreType();

    if (storeType === 'qdrant') {
        return loadQdrantVectorStore();
    }

    return loadMemoryVectorStore(filePath);
}

export async function createVectorStoreFromDocuments(
    documents: Document[],
    docPaths: string[],
): Promise<VectorStore> {
    const storeType = getVectorStoreType();
    const embeddings = createEmbeddings();
    const config = getEmbeddingConfig();

    if (storeType === 'qdrant') {
        const qdrantConfig = getQdrantConfig();
        console.log(
            `🔨 Creating Qdrant vector store (collection: ${qdrantConfig.collectionName})...`,
        );

        const client = new QdrantClient({
            url: qdrantConfig.url,
            apiKey: qdrantConfig.apiKey,
        });

        const collectionExists = await checkQdrantCollectionExists(
            client,
            qdrantConfig.collectionName,
        );
        if (collectionExists) {
            console.log(`🗑️  Deleting existing collection "${qdrantConfig.collectionName}"...`);
            await client.deleteCollection(qdrantConfig.collectionName);
        }

        const dbConfig: QdrantLibArgs = {
            client,
            collectionName: qdrantConfig.collectionName,
        };

        if (config.dimensions) {
            dbConfig.collectionConfig = {
                vectors: {
                    size: config.dimensions,
                    distance: 'Cosine',
                },
            };
        }

        const vectorStore = new QdrantVectorStore(embeddings, dbConfig);

        const batches = chunkArray(documents, UPSERT_BATCH_SIZE);
        console.log(
            `📦 Indexing ${documents.length} chunks in ${batches.length} batches (batchSize=${UPSERT_BATCH_SIZE})...`,
        );
        for (let i = 0; i < batches.length; i++) {
            await vectorStore.addDocuments(batches[i]);
            console.log(`   Batch ${i + 1}/${batches.length} done (${batches[i].length} chunks)`);
        }

        console.log(
            `✅ Indexed ${documents.length} chunks into Qdrant collection "${qdrantConfig.collectionName}"`,
        );
        return vectorStore;
    }

    console.log(`🔨 Building in-memory vector store...`);
    const vectorStore = new MemoryVectorStore(embeddings);

    const batches = chunkArray(documents, UPSERT_BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
        await vectorStore.addDocuments(batches[i]);
        console.log(`   Batch ${i + 1}/${batches.length} done (${batches[i].length} chunks)`);
    }

    saveMemoryVectorStore(vectorStore, docPaths, VECTOR_STORE_PATH);
    return vectorStore;
}
