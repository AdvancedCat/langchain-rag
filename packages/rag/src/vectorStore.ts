import type { VectorStore } from '@langchain/core/vectorstores';
import type { Document } from '@langchain/core/documents';
import { QdrantVectorStore } from '@langchain/qdrant';
import type { QdrantLibArgs } from '@langchain/qdrant';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { QdrantConfig } from './config.js';
import { getEmbeddingConfig, createEmbeddings } from './embeddings.js';

const DEFAULT_COLLECTION_NAME = 'langchain_docs';
const UPSERT_BATCH_SIZE = 100;
const QDRANT_CONNECT_TIMEOUT_MS = 5000;

function getQdrantConfig(): QdrantConfig {
    return {
        url: process.env.QDRANT_URL ?? 'http://localhost:6333',
        apiKey: process.env.QDRANT_API_KEY,
        collectionName: process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME,
    };
}

function getQdrantClient(): { client: QdrantClient; config: QdrantConfig } {
    const config = getQdrantConfig();
    const client = new QdrantClient({
        url: config.url,
        apiKey: config.apiKey,
        timeout: QDRANT_CONNECT_TIMEOUT_MS,
    });
    return { client, config };
}

export async function ensureQdrantRunning(): Promise<void> {
    const { client, config } = getQdrantClient();

    try {
        await client.getCollections();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('='.repeat(80));
        console.error('❌ Failed to connect to Qdrant vector database.');
        console.error('='.repeat(80));
        console.error();
        console.error(`   URL:      ${config.url}`);
        console.error(`   Error:    ${message}`);
        console.error();
        console.error('💡 Qdrant is required to run the RAG system. Please start it first:');
        console.error();
        console.error('   Option 1 - Using Make (recommended):');
        console.error('     make infra-up');
        console.error();
        console.error('   Option 2 - Using Docker Compose directly:');
        console.error('     cd packages/rag && docker compose up -d');
        console.error();
        console.error('   After Qdrant starts, re-run your command.');
        console.error('   To stop Qdrant: make infra-down');
        console.error();
        process.exit(1);
    }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function checkQdrantCollectionExists(
    client: QdrantClient,
    collectionName: string,
): Promise<boolean> {
    const collections = await client.getCollections();
    return collections.collections.some((c) => c.name === collectionName);
}

async function getQdrantCollectionInfo(client: QdrantClient, collectionName: string) {
    try {
        return await client.getCollection(collectionName);
    } catch {
        return null;
    }
}

export async function loadVectorStore(): Promise<VectorStore | null> {
    const { client, config: qdrantConfig } = getQdrantClient();
    const embeddings = createEmbeddings();

    console.log(`🔌 Connecting to Qdrant at ${qdrantConfig.url}...`);

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
    const embeddingConfig = getEmbeddingConfig();

    if (collectionInfo && embeddingConfig.dimensions) {
        const vectorSize = collectionInfo.config.params.vectors?.size;
        if (vectorSize && vectorSize !== embeddingConfig.dimensions) {
            console.warn(
                `⚠️  Qdrant collection vector size mismatch: collection=${vectorSize}, config=${embeddingConfig.dimensions}. Recreating collection...`,
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
}

export async function createVectorStoreFromDocuments(
    documents: Document[],
): Promise<VectorStore> {
    const { client, config: qdrantConfig } = getQdrantClient();
    const embeddings = createEmbeddings();
    const embeddingConfig = getEmbeddingConfig();

    console.log(
        `🔨 Creating Qdrant vector store (collection: ${qdrantConfig.collectionName})...`,
    );

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

    if (embeddingConfig.dimensions) {
        dbConfig.collectionConfig = {
            vectors: {
                size: embeddingConfig.dimensions,
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
