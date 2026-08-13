import type { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { DOCS_BASE, DOC_PATHS, VECTOR_STORE_PATH } from '../config.js';
import {
    loadVectorStore,
    createVectorStoreFromDocuments,
} from '../vectorStore.js';

async function loadLangchainDocs(
    docPaths: string[] = DOC_PATHS,
): Promise<Document[]> {
    const docs: Document[] = [];
    for (const path of docPaths) {
        const url = `${DOCS_BASE}/${path}.md`;
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const text = await response.text();
            docs.push(
                new Document({
                    pageContent: text,
                    metadata: { source: `${DOCS_BASE}/${path}` },
                }),
            );
        } catch {
            continue;
        }
    }
    return docs;
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
    const docs = await loadLangchainDocs();
    console.log(`Loaded ${docs.length} documentation pages.`);

    const totalChars = docs.reduce(
        (sum, doc) => sum + doc.pageContent.length,
        0,
    );
    console.log(`Total characters: ${totalChars}`);

    console.log('Splitting documents into chunks...');
    const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
    });
    const allSplits = await textSplitter.splitDocuments(docs);
    console.log(`Split documentation into ${allSplits.length} chunks.`);

    console.log('Creating embeddings and indexing into the vector store...');
    const vectorStore = await createVectorStoreFromDocuments(allSplits, DOC_PATHS);

    return vectorStore;
}
