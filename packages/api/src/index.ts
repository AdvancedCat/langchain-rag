// ============================================================================
// 服务入口：env 级联加载 → Koa 监听 → agent 预热 → 遗留 run 中断标记 → 优雅停机
//（P2 起事件日志与会话状态持久化于 Redis，方案 §7）
// ============================================================================

import './env.js';

import { EventType } from '@ag-ui/core';
import { createApp } from './app.js';
import { warmupAgent } from './agentService.js';
import { closeRedis } from './redis.js';
import { shutdownCozeLoop } from '@langchain-rag/rag';

const { app, config, runManager, persistence } = createApp();

// 进程级兜底（2026-10-10 联调加固，系统性治理留 P3）：LangGraph StreamMux 的
// 内部微任务链上的失败（子代理失败、provider 4xx 等）不经消费方的 for-await，
// 以 unhandledRejection 形式逃逸——默认行为是炸掉整个进程（联调实测三种触发源）。
// 记录后保活：受影响的 run 由 RAG_RUN_TIMEOUT_MS abort 收口 → RUN_ERROR{timeout}。
process.on('unhandledRejection', (reason) => {
    console.warn(`[api] unhandledRejection (kept alive): ${reason instanceof Error ? reason.stack : String(reason)}`);
});

const server = app.listen(config.port, config.host, () => {
    console.log(`[api] @langchain-rag/api listening on http://${config.host}:${config.port}`);
});

// 预热 agent（向量库连接 + BM25 热启动 + checkpointer，秒级）；期间 /ready 返回 503。
// 构建失败不退出进程：/ready 探测会触发重建（如基础设施晚启动的竞态恢复后）。
warmupAgent().catch(() => {});

// 重启语义（方案 §7.4）：上次进程未优雅退出的 in-flight run 置 interrupted，
// 并向对应 thread 补发 RUN_ERROR{code:"server_restart"}（persistence 内部 SETNX 幂等）
persistence
    .markInterruptedRuns(async (runId, threadId) => {
        await persistence.appendEvent(threadId, {
            type: EventType.RUN_ERROR,
            message: 'run was interrupted by a server restart',
            code: 'server_restart',
            timestamp: Date.now(),
        });
        console.warn(`[api] marked interrupted run ${runId} (thread ${threadId})`);
    })
    .then((count) => {
        if (count > 0) console.warn(`[api] ${count} stale run(s) marked interrupted`);
    })
    .catch((error) => {
        console.warn(`[api] markInterruptedRuns failed: ${error instanceof Error ? error.message : String(error)}`);
    });

const GRACEFUL_SHUTDOWN_MS = 30_000;

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down…`);

    server.close(() => console.log('[api] http server closed'));
    // 等待 in-flight run 收尾（至多 30s；优雅退出的事件都已落 Stream，
    // 超时仍未结束的 run 由下次启动的 markInterruptedRuns 补标记）
    const idle = await runManager.waitIdle(GRACEFUL_SHUTDOWN_MS);
    console.log(`[api] runs ${idle ? 'all settled' : 'still active at deadline'}`);
    await persistence.close();
    await closeRedis();
    // CozeLoop：run 全部收尾后强制上报缓冲中的 span（batch processor 定时批量）
    shutdownCozeLoop();
    // 兜底：close 回调迟迟不来（挂起的 keep-alive 连接）时强制退出
    setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
