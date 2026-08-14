export const DOCS_BASE = 'https://docs.langchain.com';

export interface QdrantConfig {
    url: string;
    apiKey?: string;
    collectionName: string;
}

export interface EmbeddingConfig {
    model: string;
    dimensions?: number;
}

export interface RetrievalConfig {
    topK: number;
    fetchK: number;
    scoreThreshold?: number;
    mmr: {
        enabled: boolean;
        lambda: number;
    };
}

const DEFAULT_RETRIEVAL_TOP_K = 4;
const DEFAULT_RETRIEVAL_FETCH_K = 20;
const DEFAULT_RETRIEVAL_MMR_LAMBDA = 0.9;

function parseIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, received: ${raw}`);
    }
    return value;
}

function parseNumberEnv(
    name: string,
    fallback: number | undefined,
): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number, received: ${raw}`);
    }
    return value;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be "true" or "false", received: ${raw}`);
}

export function getRetrievalConfig(): RetrievalConfig {
    const topK = parseIntegerEnv('RETRIEVAL_TOP_K', DEFAULT_RETRIEVAL_TOP_K);
    const fetchK = parseIntegerEnv('RETRIEVAL_FETCH_K', DEFAULT_RETRIEVAL_FETCH_K);
    const scoreThreshold = parseNumberEnv('RETRIEVAL_SCORE_THRESHOLD', undefined);
    const mmrLambda =
        parseNumberEnv('RETRIEVAL_MMR_LAMBDA', DEFAULT_RETRIEVAL_MMR_LAMBDA) ??
        DEFAULT_RETRIEVAL_MMR_LAMBDA;

    if (fetchK < topK) {
        throw new Error(
            `RETRIEVAL_FETCH_K (${fetchK}) must be greater than or equal to RETRIEVAL_TOP_K (${topK})`,
        );
    }
    if (scoreThreshold !== undefined && (scoreThreshold < -1 || scoreThreshold > 1)) {
        throw new Error(
            `RETRIEVAL_SCORE_THRESHOLD must be between -1 and 1, received: ${scoreThreshold}`,
        );
    }
    if (mmrLambda < 0 || mmrLambda > 1) {
        throw new Error(
            `RETRIEVAL_MMR_LAMBDA must be between 0 and 1, received: ${mmrLambda}`,
        );
    }

    return {
        topK,
        fetchK,
        scoreThreshold,
        mmr: {
            enabled: parseBooleanEnv('RETRIEVAL_MMR_ENABLED', false),
            lambda: mmrLambda,
        },
    };
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
