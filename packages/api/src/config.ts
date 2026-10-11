// ============================================================================
// 服务配置：环境变量 → ApiServerConfig（与 rag 的 config.ts 同一套解析约定）
// 变量清单与默认值见 ../.env.example 与 docs/api-service-plan.md §9.1
// ============================================================================

export interface ApiServerConfig {
    port: number;
    host: string;
    redisUrl: string;
    /** 前端来源白名单；'*' 表示关闭校验（仅开发） */
    corsOrigins: string[] | '*';
    maxConcurrentRuns: number;
    runTimeoutMs: number;
    threadTtlHours: number;
    sseHeartbeatMs: number;
    retrievalTraceEvents: boolean;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_CORS_ORIGINS = 'http://localhost:5173';
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_THREAD_TTL_HOURS = 720;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

function parseIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, received: ${raw}`);
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

function parseCorsOrigins(name: string, fallback: string): string[] | '*' {
    const raw = process.env[name] ?? fallback;
    const trimmed = raw.trim();
    if (trimmed === '*') return '*';
    const origins = trimmed
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
    if (origins.length === 0) {
        throw new Error(`${name} must be "*" or a comma-separated origin list, received: ${raw}`);
    }
    return origins;
}

export function getApiServerConfig(): ApiServerConfig {
    return {
        port: parseIntegerEnv('PORT', DEFAULT_PORT),
        host: process.env.HOST || DEFAULT_HOST,
        redisUrl: process.env.REDIS_URL || DEFAULT_REDIS_URL,
        corsOrigins: parseCorsOrigins('RAG_API_CORS_ORIGINS', DEFAULT_CORS_ORIGINS),
        maxConcurrentRuns: parseIntegerEnv('RAG_MAX_CONCURRENT_RUNS', DEFAULT_MAX_CONCURRENT_RUNS),
        runTimeoutMs: parseIntegerEnv('RAG_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS),
        threadTtlHours: parseIntegerEnv('THREAD_TTL_HOURS', DEFAULT_THREAD_TTL_HOURS),
        sseHeartbeatMs: parseIntegerEnv('SSE_HEARTBEAT_MS', DEFAULT_SSE_HEARTBEAT_MS),
        retrievalTraceEvents: parseBooleanEnv('RETRIEVAL_TRACE_EVENTS', true),
    };
}
