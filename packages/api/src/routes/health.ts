// ============================================================================
// 健康检查路由（方案 §5.4）
//
// /health —— 存活探针：进程活着即 200，不探测下游；
// /ready  —— 就绪探针：agent 单例（向量库 + BM25 热启动）与 Redis 可达后 200。
// ============================================================================

import Router from '@koa/router';
import { getAgentState, warmupAgent } from '../agentService.js';
import { pingRedis } from '../redis.js';

export interface HealthRouterDeps {
    version: string;
    startedAt: number;
}

export function createHealthRouter({ version, startedAt }: HealthRouterDeps): Router {
    const router = new Router();

    router.get('/health', (ctx) => {
        ctx.body = {
            status: 'ok',
            version,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        };
    });

    router.get('/ready', async (ctx) => {
        let agent = getAgentState();
        if (agent.status === 'idle' || agent.status === 'error') {
            // 容器启动竞态（Qdrant/Redis 晚于本服务）时由探针触发重建，免去手动重启；
            // 本次请求仍按当前状态应答，构建成功后下一次探针转 200
            warmupAgent().catch(() => {});
            agent = getAgentState();
        }
        const redisOk = await pingRedis();
        const ready = agent.status === 'ready' && redisOk;

        ctx.status = ready ? 200 : 503;
        ctx.body = {
            status: ready ? 'ready' : 'not_ready',
            checks: {
                agent: agent.status,
                redis: redisOk ? 'ok' : 'down',
            },
        };
    });

    return router;
}
