export const DOCS_BASE = 'https://docs.langchain.com';
export const VECTOR_STORE_PATH = './vectorstore/index.json';

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

export const DOC_PATHS = [
    'oss/javascript/langchain/agents',
    'oss/javascript/deepagents/rag',
    'oss/javascript/langchain/tools',
    'oss/javascript/langchain/models',
    'oss/javascript/deepagents/retrieval',
    'oss/javascript/langchain/knowledge-base',
    'oss/javascript/langchain/middleware',
    'oss/javascript/deepagents/overview',
    'oss/javascript/deepagents/subagents',
    'oss/javascript/deepagents/streaming',
    'oss/javascript/deepagents/frontend/subagent-streaming',
    'oss/javascript/deepagents/backends',
    'oss/javascript/langgraph/overview',
    'oss/javascript/langgraph/quickstart',
];

export const EXAMPLE_QUERY = '如何从子代理流式传输中间工具结果？';
