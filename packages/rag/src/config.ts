export const DOCS_BASE = 'https://docs.langchain.com';
export const VECTOR_STORE_PATH = './vectorstore/index.json';

export type VectorStoreType = 'memory' | 'qdrant';

export interface QdrantConfig {
    url: string;
    apiKey?: string;
    collectionName: string;
}

export interface MemoryVector {
    content: string;
    embedding: number[];
    metadata: Record<string, any>;
    id?: string;
}

export interface SerializedVectorStore {
    version: number;
    embeddingModel: string;
    embeddingDimensions?: number;
    docPaths: string[];
    vectors: MemoryVector[];
    createdAt: string;
}

export interface EmbeddingConfig {
    model: string;
    dimensions?: number;
}

const LANGCHAIN_JS_DOCS = [
    'oss/javascript/langchain/agents',
    'oss/javascript/langchain/tools',
    'oss/javascript/langchain/models',
    'oss/javascript/langchain/knowledge-base',
    'oss/javascript/langchain/middleware',
    'oss/javascript/langchain/retrieval',
    'oss/javascript/langchain/structured-output',
    'oss/javascript/langchain/streaming',
    'oss/javascript/langchain/quickstart',
    'oss/javascript/langchain/overview',
    'oss/javascript/langchain/mcp',
    'oss/javascript/langchain/human-in-the-loop',
    'oss/javascript/langchain/observability',
    'oss/javascript/langchain/messages',
];

const DEEPAGENTS_JS_DOCS = [
    'oss/javascript/deepagents/overview',
    'oss/javascript/deepagents/quickstart',
    'oss/javascript/deepagents/rag',
    'oss/javascript/deepagents/retrieval',
    'oss/javascript/deepagents/subagents',
    'oss/javascript/deepagents/streaming',
    'oss/javascript/deepagents/tools',
    'oss/javascript/deepagents/mcp',
    'oss/javascript/deepagents/middleware',
    'oss/javascript/deepagents/backends',
    'oss/javascript/deepagents/frontend',
    'oss/javascript/deepagents/frontend/overview',
    'oss/javascript/deepagents/frontend/subagent-streaming',
];

const LANGGRAPH_JS_DOCS = [
    'oss/javascript/langgraph/overview',
    'oss/javascript/langgraph/quickstart',
    'oss/javascript/langgraph/durable-execution',
    'oss/javascript/langgraph/persistence',
    'oss/javascript/langgraph/streaming',
    'oss/javascript/langgraph/human-in-the-loop',
    'oss/javascript/langgraph/functional-api',
    'oss/javascript/langgraph/graph-api',
    'oss/javascript/langgraph/memory',
];

const LANGCHAIN_PY_DOCS = [
    'oss/python/langchain/overview',
    'oss/python/langchain/quickstart',
    'oss/python/langchain/agents',
    'oss/python/langchain/tools',
    'oss/python/langchain/models',
    'oss/python/langchain/streaming',
    'oss/python/langchain/structured-output',
    'oss/python/langchain/retrieval',
];

const LANGGRAPH_PY_DOCS = [
    'oss/python/langgraph/overview',
    'oss/python/langgraph/quickstart',
    'oss/python/langgraph/persistence',
    'oss/python/langgraph/streaming',
    'oss/python/langgraph/human-in-the-loop',
    'oss/python/langgraph/durable-execution',
];

const DEEPAGENTS_PY_DOCS = [
    'oss/python/deepagents/overview',
    'oss/python/deepagents/rag',
    'oss/python/deepagents/quickstart',
    'oss/python/deepagents/tools',
    'oss/python/deepagents/subagents',
    'oss/python/deepagents/streaming',
    'oss/python/deepagents/backends',
    'oss/python/deepagents/mcp',
];

export const DOC_PATHS = [
    ...LANGCHAIN_JS_DOCS,
    ...DEEPAGENTS_JS_DOCS,
    ...LANGGRAPH_JS_DOCS,
    ...LANGCHAIN_PY_DOCS,
    ...LANGGRAPH_PY_DOCS,
    ...DEEPAGENTS_PY_DOCS,
];

export const EXAMPLE_QUERY = '如何从子代理流式传输中间工具结果？';
