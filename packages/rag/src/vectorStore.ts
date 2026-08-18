import type { VectorStore } from '@langchain/core/vectorstores';
import type { Document, DocumentInterface } from '@langchain/core/documents';
import { QdrantVectorStore } from '@langchain/qdrant';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { QdrantConfig } from './config.js';
import { getEmbeddingConfig, createEmbeddings } from './embeddings.js';
import { composeSearchText } from './chunking/compose.js';
import { contentHash, toDeterministicUuid } from './chunking/ids.js';

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

/**
 * 入库路径：自定义 upsert（plan §2.5）。
 *
 * - embedding 输入用 composeSearchText（sectionPath 前缀注入，决策 D3）；
 * - Qdrant payload 只存干净 content + 结构化 metadata，与 @langchain/qdrant
 *   的读写格式同源（F2），fromExistingCollection 查询路径完全兼容；
 * - point id 由 chunk id 派生确定性 UUID（sha256 格式化），rebuild 幂等、
 *   同文档重入覆盖不追加。
 */
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

    const dimensions =
        embeddingConfig.dimensions ?? (await embeddings.embedQuery('dimension probe')).length;
    await client.createCollection(qdrantConfig.collectionName, {
        vectors: {
            size: dimensions,
            distance: 'Cosine',
        },
    });

    const batches = chunkArray(documents, UPSERT_BATCH_SIZE);
    console.log(
        `📦 Indexing ${documents.length} chunks in ${batches.length} batches (batchSize=${UPSERT_BATCH_SIZE})...`,
    );
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const vectors = await embeddings.embedDocuments(
            batch.map((doc) => composeSearchText(doc.pageContent, doc.metadata)),
        );
        await client.upsert(qdrantConfig.collectionName, {
            wait: true,
            points: batch.map((doc, j) => ({
                id: pointIdFor(doc),
                vector: vectors[j],
                payload: { content: doc.pageContent, metadata: doc.metadata ?? {} },
            })),
        });
        console.log(`   Batch ${i + 1}/${batches.length} done (${batch.length} chunks)`);
    }

    console.log(
        `✅ Indexed ${documents.length} chunks into Qdrant collection "${qdrantConfig.collectionName}"`,
    );

    // 查询路径仍走 lib 的 VectorStore 实现，与 loadVectorStore 返回一致
    return QdrantVectorStore.fromExistingCollection(embeddings, {
        client,
        collectionName: qdrantConfig.collectionName,
    });
}

function pointIdFor(doc: Document): string {
    const id = doc.metadata?.id;
    if (typeof id === 'string' && id.length > 0) return toDeterministicUuid(id);
    return toDeterministicUuid(contentHash(doc.pageContent));
}

export function getSharedQdrantClient(): QdrantClient {
    const { client } = getQdrantClient();
    return client;
}

/**
 * 从 Qdrant scroll 遍历全部 documents，用于构建内存中的 BM25 索引。
 *
 * TRADE-OFF（权衡）：当前实现将所有 document 的 pageContent 一次性累积到数组中，
 * 再整体传给 BM25Retriever.build()。优点是实现简单、小 corpus 下速度快
 * （当前约 2.7k chunks ≈ 45MB 稳态内存 / 82MB 构建峰值）；缺点是内存不随
 * corpus 线性扩展，规模上来后需要重新评估。
 *
 * 各规模下的内存估算（JS Map 条目开销是主要来源）：
 *   - 10k chunks  → ~170MB 稳态 / ~300MB 峰值  （安全）
 *   - 50k chunks  → ~800MB 稳态 / ~1.5GB 峰值  （Node 默认堆约 1.4GB，需警惕）
 *   - 100k chunks → ~1.6GB 稳态 / ~3GB 峰值    （有 OOM 风险）
 *
 * 主要内存消耗来自每个文档的 termFreq Map 条目（每个约 50 字节），
 * 而非 pageContent 字符串本身（后者与 dense 检索路径共享引用，不是额外开销）。
 *
 * 何时优化：corpus 超过 ~10k chunks，或进程 RSS 超过 500MB 时再行动。
 * 优化路径（按改造代价从低到高）：
 *   1. 流式增量构建：scroll 一批构建一批，去掉中间 Document[] 全量数组，
 *      增量更新 termFreq / docFreq，避免双份驻留。
 *   2. 紧凑数据结构：用扁平数组 + 共享词表替换 Map<string, number>，
 *      降低 V8 对 Map 条目的 per-entry 开销。
 *   3. 迁移到 Qdrant 原生 sparse vectors（fastembed BM25）：倒排索引由
 *      Qdrant（Rust 进程）管理，JS 侧零内存开销，且支持增量更新，无需
 *      启动时全量 reload。
 */
export async function fetchAllDocumentsFromQdrant(): Promise<DocumentInterface[]> {
    const { client, config } = getQdrantClient();
    const documents: DocumentInterface[] = [];
    let offset: string | null = null;
    const limit = 200;

    do {
        const response = await client.scroll(config.collectionName, {
            limit,
            offset: offset ?? undefined,
            with_payload: true,
            with_vector: false,
        });

        const points = (response as { points?: Array<{ payload?: Record<string, unknown> | null }> }).points;
        if (!points) break;

        for (const point of points) {
            const payload = point.payload ?? {};
            const pageContent = typeof payload.content === 'string'
                ? payload.content
                : (typeof payload.pageContent === 'string' ? payload.pageContent : '');
            const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
            if (pageContent) {
                documents.push({ pageContent, metadata });
            }
        }

        offset = ((response as { next_page_offset?: string | null }).next_page_offset ?? null) as string | null;
    } while (offset !== null);

    return documents;
}
