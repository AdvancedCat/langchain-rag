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

export interface IngestionConfig {
    chunkSize: number;
    chunkOverlap: number;
    /** markdown header 切分的最大层级（h1-hN），影响 section 粒度 */
    maxHeaderDepth: number;
}

export interface RetrievalConfig {
    topK: number;
    fetchK: number;
    scoreThreshold?: number;
    abstentionThreshold: number;
    mmr: {
        enabled: boolean;
        lambda: number;
    };
    hybrid: {
        enabled: boolean;
        rrfConstant: number;
        sparseTopK: number;
        denseTopK: number;
        denseWeight: number;
        sparseWeight: number;
    };
    queryTransform: {
        rewrite: boolean;
        multiQuery: boolean;
        multiQueryCount: number;
    };
    rerank: {
        enabled: boolean;
        model: string;
        topN: number;
        rerankUrl: string;
    };
    /**
     * Rerank 弃答闸门（方向二）：检索排序不变（仍 hybrid-rewrite 融合），
     * 仅用 cross-encoder 对 top-fetchK 候选打分做"是否值得回答"判定，
     * 替代 dense cosine 作为 abstention 信号（dense 信号保留为 API 失败回退）。
     * 与 MMR 互斥：MMR 只返回 topK 多样性筛选结果，会饿死 fetchK 闸门候选池。
     */
    rerankGate: {
        enabled: boolean;
        threshold: number;
    };
}

const DEFAULT_RETRIEVAL_TOP_K = 4;
const DEFAULT_RETRIEVAL_FETCH_K = 20;
export const DEFAULT_ABSTENTION_THRESHOLD = 0.78;
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;
/**
 * A/B 结论（evals/results/mdheader-*.raw.json）：h4 粒度下同文档 section 霸屏
 * top4 致 Hit@4 回退 8pp；h1-h2 切分 Hit@4 94.6% / Hit@10 100%，全面优于旧切分。
 */
export const DEFAULT_MAX_HEADER_DEPTH = 2;
const DEFAULT_RETRIEVAL_MMR_LAMBDA = 0.9;
const DEFAULT_RRF_CONSTANT = 60;
const DEFAULT_SPARSE_TOP_K = 5;
const DEFAULT_DENSE_TOP_K = 30;
const DEFAULT_DENSE_WEIGHT = 2;
const DEFAULT_SPARSE_WEIGHT = 0.5;
const DEFAULT_MULTI_QUERY_COUNT = 3;
const DEFAULT_RERANK_MODEL = 'qwen3-rerank';
const DEFAULT_RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
/**
 * 2026-09-22 golden 数据集标定（evals/results/rerank-gate-calibration-20260922.json）：
 * answerable 最低 0.4949、unanswerable 次低 0.5327，取零误杀区间中点，
 * 误杀 0/37、漏判 6/7（漏判项交由生成层 analyst 判无关兜底）、总正确率 86.4%（全局最优）。
 */
export const DEFAULT_RERANK_GATE_THRESHOLD = 0.52;

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

export function getIngestionConfig(): IngestionConfig {
    const chunkSize = parseIntegerEnv('CHUNK_SIZE', DEFAULT_CHUNK_SIZE);
    const chunkOverlap = parseIntegerEnv('CHUNK_OVERLAP', DEFAULT_CHUNK_OVERLAP);
    const maxHeaderDepth = parseIntegerEnv('INGESTION_MAX_HEADER_DEPTH', DEFAULT_MAX_HEADER_DEPTH);

    if (chunkOverlap >= chunkSize) {
        throw new Error(
            `CHUNK_OVERLAP (${chunkOverlap}) must be smaller than CHUNK_SIZE (${chunkSize})`,
        );
    }
    if (maxHeaderDepth < 1 || maxHeaderDepth > 6) {
        throw new Error(
            `INGESTION_MAX_HEADER_DEPTH must be between 1 and 6, received: ${maxHeaderDepth}`,
        );
    }

    return { chunkSize, chunkOverlap, maxHeaderDepth };
}

export function getRetrievalConfig(): RetrievalConfig {
    const topK = parseIntegerEnv('RETRIEVAL_TOP_K', DEFAULT_RETRIEVAL_TOP_K);
    const fetchK = parseIntegerEnv('RETRIEVAL_FETCH_K', DEFAULT_RETRIEVAL_FETCH_K);
    const scoreThreshold = parseNumberEnv('RETRIEVAL_SCORE_THRESHOLD', undefined);
    const abstentionThreshold =
        parseNumberEnv('RETRIEVAL_ABSTENTION_THRESHOLD', DEFAULT_ABSTENTION_THRESHOLD) ??
        DEFAULT_ABSTENTION_THRESHOLD;
    const mmrLambda =
        parseNumberEnv('RETRIEVAL_MMR_LAMBDA', DEFAULT_RETRIEVAL_MMR_LAMBDA) ??
        DEFAULT_RETRIEVAL_MMR_LAMBDA;
    const rrfConstant = parseNumberEnv('RETRIEVAL_RRF_CONSTANT', DEFAULT_RRF_CONSTANT) ?? DEFAULT_RRF_CONSTANT;
    const sparseTopK = parseIntegerEnv('RETRIEVAL_SPARSE_TOP_K', DEFAULT_SPARSE_TOP_K);
    const denseTopK = parseIntegerEnv('RETRIEVAL_DENSE_TOP_K', DEFAULT_DENSE_TOP_K);
    const denseWeight = parseNumberEnv('RETRIEVAL_DENSE_WEIGHT', DEFAULT_DENSE_WEIGHT) ?? DEFAULT_DENSE_WEIGHT;
    const sparseWeight = parseNumberEnv('RETRIEVAL_SPARSE_WEIGHT', DEFAULT_SPARSE_WEIGHT) ?? DEFAULT_SPARSE_WEIGHT;
    const multiQueryCount = parseIntegerEnv('RETRIEVAL_MULTI_QUERY_COUNT', DEFAULT_MULTI_QUERY_COUNT);

    const hybridEnabled = parseBooleanEnv('RETRIEVAL_HYBRID_ENABLED', true);
    const queryRewriteEnabled = parseBooleanEnv('RETRIEVAL_QUERY_REWRITE', true);
    const multiQueryEnabled = parseBooleanEnv('RETRIEVAL_MULTI_QUERY', false);
    const mmrEnabled = parseBooleanEnv('RETRIEVAL_MMR_ENABLED', false);
    const rerankEnabled = parseBooleanEnv('RETRIEVAL_RERANK_ENABLED', false);
    const rerankModel = process.env.RETRIEVAL_RERANK_MODEL ?? DEFAULT_RERANK_MODEL;
    const rerankTopN = parseIntegerEnv('RETRIEVAL_RERANK_TOP_N', DEFAULT_RETRIEVAL_TOP_K);
    const rerankUrl = process.env.DASHSCOPE_RERANK_URL ?? DEFAULT_RERANK_URL;
    const rerankGateEnabled = parseBooleanEnv('RETRIEVAL_RERANK_GATE_ENABLED', true);
    const rerankGateThreshold =
        parseNumberEnv('RETRIEVAL_RERANK_GATE_THRESHOLD', DEFAULT_RERANK_GATE_THRESHOLD) ??
        DEFAULT_RERANK_GATE_THRESHOLD;

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
    if (abstentionThreshold < 0 || abstentionThreshold > 1) {
        throw new Error(
            `RETRIEVAL_ABSTENTION_THRESHOLD must be between 0 and 1, received: ${abstentionThreshold}`,
        );
    }
    if (mmrLambda < 0 || mmrLambda > 1) {
        throw new Error(
            `RETRIEVAL_MMR_LAMBDA must be between 0 and 1, received: ${mmrLambda}`,
        );
    }
    if (rrfConstant <= 0) {
        throw new Error(`RETRIEVAL_RRF_CONSTANT must be positive, received: ${rrfConstant}`);
    }
    if (sparseTopK <= 0 || denseTopK <= 0) {
        throw new Error('RETRIEVAL_SPARSE_TOP_K and RETRIEVAL_DENSE_TOP_K must be positive');
    }
    if (multiQueryCount < 1 || multiQueryCount > 10) {
        throw new Error('RETRIEVAL_MULTI_QUERY_COUNT must be between 1 and 10');
    }
    if (denseWeight <= 0 || sparseWeight <= 0) {
        throw new Error('RETRIEVAL_DENSE_WEIGHT and RETRIEVAL_SPARSE_WEIGHT must be positive');
    }
    if (rerankEnabled && mmrEnabled) {
        throw new Error('RETRIEVAL_RERANK_ENABLED and RETRIEVAL_MMR_ENABLED cannot both be true');
    }
    if (rerankGateEnabled && mmrEnabled) {
        throw new Error(
            'RETRIEVAL_RERANK_GATE_ENABLED and RETRIEVAL_MMR_ENABLED cannot both be true: ' +
                'MMR returns only topK diversity-filtered chunks, so the gate would score a starved ' +
                'pool and bias toward false abstentions. Disable the gate to use MMR with the dense fallback.',
        );
    }
    if (rerankEnabled && rerankTopN > fetchK) {
        throw new Error(
            `RETRIEVAL_RERANK_TOP_N (${rerankTopN}) must be less than or equal to RETRIEVAL_FETCH_K (${fetchK})`,
        );
    }
    if (rerankTopN <= 0) {
        throw new Error('RETRIEVAL_RERANK_TOP_N must be positive');
    }
    if (rerankGateThreshold < 0 || rerankGateThreshold > 1) {
        throw new Error(
            `RETRIEVAL_RERANK_GATE_THRESHOLD must be between 0 and 1, received: ${rerankGateThreshold}`,
        );
    }

    return {
        topK,
        fetchK,
        scoreThreshold,
        abstentionThreshold,
        mmr: {
            enabled: mmrEnabled,
            lambda: mmrLambda,
        },
        hybrid: {
            enabled: hybridEnabled,
            rrfConstant,
            sparseTopK,
            denseTopK,
            denseWeight,
            sparseWeight,
        },
        queryTransform: {
            rewrite: queryRewriteEnabled,
            multiQuery: multiQueryEnabled,
            multiQueryCount,
        },
        rerank: {
            enabled: rerankEnabled,
            model: rerankModel,
            topN: rerankTopN,
            rerankUrl,
        },
        rerankGate: {
            enabled: rerankGateEnabled,
            threshold: rerankGateThreshold,
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
