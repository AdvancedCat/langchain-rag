// ============================================================================
// 服务入口：env 级联加载 → Koa 监听 → agent 预热 → 优雅停机
//（P0 基座：健康/就绪探针；run 执行与 AG-UI 事件流在 P1/P2 接入，方案 §11）
// ============================================================================

import './env.js';

import { createApp } from './app.js';
import { warmupAgent } from './agentService.js';
import { closeRedis } from './redis.js';

const { app, config } = createApp();

const server = app.listen(config.port, config.host, () => {
    console.log(`[api] @langchain-rag/api listening on http://${config.host}:${config.port}`);
});

// 预热 agent（向量库连接 + BM25 热启动，秒级）；期间 /ready 返回 503。
// 构建失败不退出进程：/ready 探测会触发重建（如基础设施晚启动的竞态恢复后）。
warmupAgent().catch(() => {});

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down…`);

    server.close(() => console.log('[api] http server closed'));
    // P0 无活跃 run 需等待；P1/P2 起 RunManager 在此等待 in-flight run 收尾
    await closeRedis();
    // 兜底：close 回调迟迟不来（挂起的 keep-alive 连接）时强制退出
    setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
