import type { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { DOCS_BASE, DOC_PATHS, VECTOR_STORE_PATH } from '../config.js';
import {
    loadVectorStore,
    createVectorStoreFromDocuments,
} from '../vectorStore.js';

interface LoadedDoc {
    doc: Document;
    path: string;
    fetchedAt: string;
}

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
            const fetchedAt = new Date().toISOString();
            results.push({
                doc: new Document({
                    pageContent: text,
                    metadata: {
                        source: `${DOCS_BASE}/${path}`,
                        docPath: path,
                        docType: 'markdown',
                        fetchedAt,
                    },
                }),
                path,
                fetchedAt,
            });
        } catch {
            continue;
        }
    }
    return results;
}

export async function buildVectorStore(
    forceRebuild = false,
): Promise<VectorStore> {
    if (!forceRebuild) {
        const existing = await loadVectorStore(VECTOR_STORE_PATH);
        if (existing) {
            return existing;
        }
    }

    console.log('🔨 Building new vector store from documentation...');
    console.log('Loading LangChain documentation...');
    const loadedDocs = await loadLangchainDocs();
    console.log(`Loaded ${loadedDocs.length} documentation pages.`);

    const totalChars = loadedDocs.reduce(
        (sum, { doc }) => sum + doc.pageContent.length,
        0,
    );
    console.log(`Total characters: ${totalChars}`);

    console.log('Splitting documents into chunks...');
    const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
    });

    const indexedAt = new Date().toISOString();
    const allSplits: Document[] = [];

    for (const { doc, path } of loadedDocs) {
        const splits = await textSplitter.splitDocuments([doc]);
        splits.forEach((split, idx) => {
            split.metadata.chunkIndex = idx;
            split.metadata.totalChunks = splits.length;
            split.metadata.indexedAt = indexedAt;
        });
        allSplits.push(...splits);
    }

    console.log(`Split documentation into ${allSplits.length} chunks.`);

    console.log('Creating embeddings and indexing into the vector store...');
    const vectorStore = await createVectorStoreFromDocuments(allSplits, DOC_PATHS);

    return vectorStore;
}
