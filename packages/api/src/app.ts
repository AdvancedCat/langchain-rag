// ============================================================================
// Koa 应用装配（与监听分离，便于测试直接 import createApp 并注入内存持久化）
// ============================================================================

import Koa from 'koa';
import { createRequire } from 'node:module';
import bodyParser from '@koa/bodyparser';
import { getApiServerConfig, type ApiServerConfig } from './config.js';
import { RunManager } from './runManager.js';
import { createHealthRouter } from './routes/health.js';
import { createAguiRouter } from './routes/agui.js';
import { createThreadsRouter } from './routes/threads.js';
import { createRedisPersistence } from './persistence/redis.js';
import type { Persistence } from './persistence/types.js';

/** 统一错误体：{"error":{"code":…,"message":…}}（方案 §5 约定） */
export interface ApiErrorBody {
    error: { code: string; message: string };
}

function corsMiddleware(corsOrigins: string[] | '*'): Koa.Middleware {
    return async (ctx, next) => {
        const origin = ctx.get('Origin');
        if (corsOrigins === '*' || (origin && corsOrigins.includes(origin))) {
            ctx.set('Access-Control-Allow-Origin', corsOrigins === '*' ? '*' : origin);
            ctx.set('Vary', 'Origin');
            ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
        }
        if (ctx.method === 'OPTIONS') {
            ctx.status = 204;
            return;
        }
        await next();
    };
}

export interface CreateAppResult {
    app: Koa;
    config: ApiServerConfig;
    runManager: RunManager;
    persistence: Persistence;
}

export interface CreateAppOptions {
    /** 测试注入内存实现；缺省为 Redis 实现（事件日志/元数据，方案 §7） */
    persistence?: Persistence;
}

export function createApp(options: CreateAppOptions = {}): CreateAppResult {
    const config = getApiServerConfig();
    const app = new Koa();
    // tsx 直跑（非 npm 脚本上下文）时 npm_package_version 不存在，读 package.json 兜底
    const require = createRequire(import.meta.url);
    const persistence =
        options.persistence ??
        createRedisPersistence({ redisUrl: config.redisUrl, threadTtlHours: config.threadTtlHours });
    const runManager = new RunManager({
        config: { maxConcurrentRuns: config.maxConcurrentRuns, runTimeoutMs: config.runTimeoutMs },
        persistence,
    });

    app.use(corsMiddleware(config.corsOrigins));
    app.use(bodyParser({ enableTypes: ['json'] }));

    // 错误兜底：路由/下游异常统一为 JSON 错误体，不向客户端泄漏堆栈
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (error) {
            ctx.status = 500;
            ctx.body = {
                error: {
                    code: 'internal_error',
                    message: error instanceof Error ? error.message : String(error),
                },
            } satisfies ApiErrorBody;
        }
    });

    app.use(
        createHealthRouter({
            version: require('../package.json').version as string,
            startedAt: Date.now(),
        }).routes(),
    );

    app.use(
        createAguiRouter({
            runManager,
            persistence,
            sseHeartbeatMs: config.sseHeartbeatMs,
        }).routes(),
    );

    app.use(
        createThreadsRouter({
            runManager,
            persistence,
            sseHeartbeatMs: config.sseHeartbeatMs,
        }).routes(),
    );

    // 404 兜底（路由未命中时 Koa 默认裸文本 Not Found）
    app.use((ctx) => {
        ctx.status = 404;
        ctx.body = { error: { code: 'not_found', message: `no route: ${ctx.method} ${ctx.path}` } };
    });

    return { app, config, runManager, persistence };
}
