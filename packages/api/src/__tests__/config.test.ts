import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiServerConfig } from '../config.js';

// 环境无关：显式清空所有可配置变量，验证默认值与解析/校验行为

const ENV_KEYS = [
    'PORT',
    'HOST',
    'REDIS_URL',
    'RAG_API_CORS_ORIGINS',
    'RAG_MAX_CONCURRENT_RUNS',
    'RAG_RUN_TIMEOUT_MS',
    'THREAD_TTL_HOURS',
    'SSE_HEARTBEAT_MS',
    'RETRIEVAL_TRACE_EVENTS',
] as const;

afterEach(() => {
    for (const key of ENV_KEYS) {
        vi.unstubAllEnvs();
        delete process.env[key];
    }
});

describe('getApiServerConfig 默认值', () => {
    it('全部变量缺省时返回 §9.1 的默认配置', () => {
        for (const key of ENV_KEYS) delete process.env[key];

        expect(getApiServerConfig()).toEqual({
            port: 3000,
            host: '0.0.0.0',
            redisUrl: 'redis://localhost:6379',
            corsOrigins: ['http://localhost:5173'],
            maxConcurrentRuns: 4,
            runTimeoutMs: 300_000,
            threadTtlHours: 720,
            sseHeartbeatMs: 15_000,
            retrievalTraceEvents: true,
        });
    });
});

describe('getApiServerConfig 解析与校验', () => {
    it('读取覆盖值：PORT/HOST/REDIS_URL/布尔与整数变量', () => {
        vi.stubEnv('PORT', '8080');
        vi.stubEnv('HOST', '127.0.0.1');
        vi.stubEnv('REDIS_URL', 'redis://redis:6379/2');
        vi.stubEnv('RAG_MAX_CONCURRENT_RUNS', '2');
        vi.stubEnv('RETRIEVAL_TRACE_EVENTS', 'false');

        const config = getApiServerConfig();
        expect(config.port).toBe(8080);
        expect(config.host).toBe('127.0.0.1');
        expect(config.redisUrl).toBe('redis://redis:6379/2');
        expect(config.maxConcurrentRuns).toBe(2);
        expect(config.retrievalTraceEvents).toBe(false);
    });

    it('CORS 白名单：逗号分隔解析、去空白、* 直通', () => {
        vi.stubEnv('RAG_API_CORS_ORIGINS', 'http://a.com, http://b.com ');
        expect(getApiServerConfig().corsOrigins).toEqual(['http://a.com', 'http://b.com']);

        vi.stubEnv('RAG_API_CORS_ORIGINS', '*');
        expect(getApiServerConfig().corsOrigins).toBe('*');
    });

    it('非法输入直接抛错（沿用 rag config.ts 的 fail-fast 约定）', () => {
        vi.stubEnv('PORT', 'not-a-number');
        expect(() => getApiServerConfig()).toThrow(/PORT/);

        vi.unstubAllEnvs();
        vi.stubEnv('PORT', '0');
        expect(() => getApiServerConfig()).toThrow(/PORT/);

        vi.unstubAllEnvs();
        vi.stubEnv('RAG_API_CORS_ORIGINS', '  , ');
        expect(() => getApiServerConfig()).toThrow(/RAG_API_CORS_ORIGINS/);
    });
});
