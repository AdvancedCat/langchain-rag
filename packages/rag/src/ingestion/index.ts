import type { VectorStore } from '@langchain/core/vectorstores';
import type { DocumentInterface } from '@langchain/core/documents';
import { Document } from '@langchain/core/documents';
import { DOCS_BASE, DOC_PATHS, getIngestionConfig } from '../config.js';
import {
    ensureQdrantRunning,
    loadVectorStore,
    createVectorStoreFromDocuments,
    fetchAllDocumentsFromQdrant,
} from '../vectorStore.js';
import { getGlobalBM25Retriever, resetGlobalBM25Retriever } from '../retrieval/retrievers/bm25.js';
import { runChunkingPipeline, CHUNKER_VERSION } from '../chunking/index.js';
import type { SplitDocInput } from '../chunking/index.js';

interface LoadedDoc {
    input: SplitDocInput;
    fetchedAt: string;
}

/** Loader：取数产出 SplitDocInput（text + docId + source + docPath + declaredType + fetchedAt） */
async function loadLangchainDocs(
    docPaths: string[] = DOC_PATHS,
): Promise<LoadedDoc[]> {
    const results: LoadedDoc[] = [];
    for (const path of docPaths) {
        const url = `${DOCS_BASE}/${path}.md`;
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const text = await response.text();
            if (text.trim().length === 0) continue;
            const fetchedAt = new Date().toISOString();
            results.push({
                input: {
                    text,
                    docId: `${DOCS_BASE}/${path}`,
                    source: `${DOCS_BASE}/${path}`,
                    docPath: path,
                    declaredType: 'markdown',
                },
                fetchedAt,
            });
        } catch {
            continue;
        }
    }
    return results;
}

/**
 * 热启动守卫（决策 D6）：复用已有 collection 前比对 chunkerVersion。
 * 旧 collection（无 chunkerVersion 字段）与版本不一致都提示 --rebuild，
 * 根治"切分代码升级、旧索引静默复用"的坑（plan §1.3）。
 */
function warnOnChunkerVersionMismatch(documents: DocumentInterface[]): void {
    if (documents.length === 0) return;
    const upToDate = documents.some(
        (doc) => doc.metadata?.chunkerVersion === CHUNKER_VERSION,
    );
    if (upToDate) return;
    const stored = new Set(
        documents
            .map((doc) => doc.metadata?.chunkerVersion)
            .filter((v): v is string => typeof v === 'string'),
    );
    const storedLabel = stored.size > 0 ? [...stored].join(', ') : '(none, pre-chunking-pipeline)';
    console.warn(
        `⚠️  Existing index was built with chunker [${storedLabel}], current is [${CHUNKER_VERSION}]. ` +
            'Chunk boundaries are stale — re-run with --rebuild to apply the new chunking strategy.',
    );
}

async function buildBM25IndexFromDocuments(documents: DocumentInterface[]): Promise<void> {
    resetGlobalBM25Retriever();
    const bm25 = getGlobalBM25Retriever();
    bm25.build(documents);
    console.log(`📝 Built BM25 index (${bm25.size()} documents)`);
}

export async function buildVectorStore(
    forceRebuild = false,
): Promise<VectorStore> {
    await ensureQdrantRunning();

    if (!forceRebuild) {
        const existing = await loadVectorStore();
        if (existing) {
            console.log('📝 Loading all documents from Qdrant for BM25 index...');
            const allDocs = await fetchAllDocumentsFromQdrant();
            warnOnChunkerVersionMismatch(allDocs);
            await buildBM25IndexFromDocuments(allDocs);
            return existing;
        }
    }

    console.log('🔨 Building new vector store from documentation...');
    console.log('Loading LangChain documentation...');
    const loadedDocs = await loadLangchainDocs();
    console.log(`Loaded ${loadedDocs.length} documentation pages.`);

    const totalChars = loadedDocs.reduce(
        (sum, { input }) => sum + input.text.length,
        0,
    );
    console.log(`Total characters: ${totalChars}`);

    const { chunkSize, chunkOverlap, maxHeaderDepth } = getIngestionConfig();
    console.log(`Chunking with header-aware pipeline (chunkSize=${chunkSize}, chunkOverlap=${chunkOverlap}, maxHeaderDepth=${maxHeaderDepth})...`);

    // indexedAt / fetchedAt 归 ingestion（决策 D4），Splitter 输出保持确定性
    const indexedAt = new Date().toISOString();
    const allSplits: Document[] = [];

    for (const { input, fetchedAt } of loadedDocs) {
        try {
            const result = await runChunkingPipeline(input, {
                chunkSize,
                chunkOverlap,
                maxHeaderDepth,
            });
            for (const warning of result.warnings) {
                console.warn(`⚠️  [chunking:${input.docPath}] ${warning.code}: ${warning.message}`);
            }
            for (const chunk of result.chunks) {
                allSplits.push(
                    new Document({
                        pageContent: chunk.content,
                        metadata: {
                            ...chunk.metadata,
                            id: chunk.id,
                            fetchedAt,
                            indexedAt,
                        },
                    }),
                );
            }
        } catch (error) {
            // 错误隔离：单文档失败降级为记录 + 跳过（plan §2.1）
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`⚠️  Skipping ${input.docPath ?? input.docId}: ${message}`);
        }
    }

    console.log(`Split documentation into ${allSplits.length} chunks.`);

    await buildBM25IndexFromDocuments(allSplits);

    console.log('Creating embeddings and indexing into the vector store...');
    const vectorStore = await createVectorStoreFromDocuments(allSplits);

    return vectorStore;
}
