// ============================================================================
// Redis 客户端（懒连接，进程内共享）
//
// P0 仅用于 /ready 连通性探测；P2 起承载事件日志（Stream）、会话元数据与
// LangGraph checkpoint。lazyConnect 保证服务启动顺序不依赖 Redis 先就绪。
// ============================================================================

import Redis from 'ioredis';
import { getApiServerConfig } from './config.js';

let client: Redis | undefined;

export function getRedis(): Redis {
    if (!client) {
        client = new Redis(getApiServerConfig().redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryStrategy: (times) => Math.min(times * 500, 5_000),
        });
        client.on('error', (error) => {
            // ioredis 未挂 error 监听时连接错误会抛未捕获异常
            console.warn(`[redis] ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return client;
}

/** /ready 探测用：能 PING 通即认为可达 */
export async function pingRedis(): Promise<boolean> {
    try {
        const redis = getRedis();
        if (redis.status === 'wait' || redis.status === 'end') {
            await redis.connect();
        }
        const reply = await redis.ping();
        return reply === 'PONG';
    } catch {
        return false;
    }
}

/** 优雅停机时调用 */
export async function closeRedis(): Promise<void> {
    if (client) {
        await client.quit().catch(() => client?.disconnect());
        client = undefined;
    }
}
