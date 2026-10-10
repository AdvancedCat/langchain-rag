// ============================================================================
// POST /agui —— AG-UI v1.0 HTTP+SSE binding 标准端点（方案 §5.1）
// POST /threads/:threadId/runs/:runId/cancel —— 显式取消（方案 §5.2）
//
// RunAgentInput 消费策略（契约）：只取最后一条 user 消息作为本轮输入，
// 历史以服务端为准（P2 checkpointer 落地前的过渡语义）。
// ============================================================================

import Router from '@koa/router';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { getAgentState } from '../agentService.js';
import type { RunManager } from '../runManager.js';
import { initSSE, startHeartbeat, writeEvent } from '../sse.js';
import { EventEncoder } from '@ag-ui/encoder';

interface RunAgentInputBody {
    threadId?: unknown;
    runId?: unknown;
    messages?: unknown;
}

/** 从 AG-UI messages 提取最后一条 user 消息文本 */
function extractLastUserQuery(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) return undefined;
    const userMessages = messages.filter(
        (m): m is { role: string; content: unknown } =>
            typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'user',
    );
    const last = userMessages.at(-1);
    if (!last) return undefined;
    const content = last.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const text = content
            .map((part) =>
                typeof part === 'string'
                    ? part
                    : part && typeof part === 'object' && 'text' in part
                      ? String((part as { text?: unknown }).text ?? '')
                      : '',
            )
            .join('');
        return text || undefined;
    }
    return undefined;
}

export interface AguiRouterDeps {
    runManager: RunManager;
    sseHeartbeatMs: number;
}

export function createAguiRouter({ runManager, sseHeartbeatMs }: AguiRouterDeps): Router {
    const router = new Router();

    router.post('/agui', async (ctx) => {
        if (getAgentState().status !== 'ready') {
            ctx.status = 503;
            ctx.body = { error: { code: 'agent_not_ready', message: 'agent singleton is not ready yet' } };
            return;
        }

        const parsed = RunAgentInputSchema.safeParse(ctx.request.body as RunAgentInputBody);
        if (!parsed.success) {
            ctx.status = 400;
            ctx.body = {
                error: { code: 'invalid_input', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
            };
            return;
        }
        const { threadId, runId, messages } = parsed.data;

        const query = extractLastUserQuery(messages);
        if (!query) {
            ctx.status = 400;
            ctx.body = { error: { code: 'no_user_message', message: 'RunAgentInput.messages must contain at least one user message' } };
            return;
        }

        // 重复 runId：返回既有 run 状态（幂等友好），不重复执行
        if (runManager.getRun(runId)) {
            ctx.status = 409;
            ctx.body = { error: { code: 'run_id_conflict', message: `runId ${runId} already exists` } };
            return;
        }

        const registered = runManager.register(threadId, runId);
        if (!registered.ok) {
            if (registered.code === 'run_already_active') {
                ctx.status = 409;
                ctx.body = {
                    error: {
                        code: 'run_already_active',
                        message: `thread ${threadId} already has an active run`,
                    },
                    runId: registered.activeRunId,
                };
                return;
            }
            ctx.status = 429;
            ctx.set('Retry-After', '5');
            ctx.body = { error: { code: 'too_many_concurrent', message: 'server is at max concurrent runs' } };
            return;
        }

        // ---- 登记 succeeded：开 SSE，先订阅再启动，保证不漏首事件 ----
        const res = initSSE(ctx);
        const encoder = new EventEncoder();
        const stopHeartbeat = startHeartbeat(res, sseHeartbeatMs);

        let closed = false;
        const finish = () => {
            if (closed) return;
            closed = true;
            stopHeartbeat();
            if (!res.writableEnded) res.end();
        };

        const unsubscribe = runManager.subscribe(runId, (event) => {
            writeEvent(res, encoder, event);
            if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
                finish();
            }
        });
        if (!unsubscribe) {
            // 极小窗口内 run 已终态（如瞬时报错）——直接收流
            finish();
            return;
        }

        // 客户端断开：仅退订，run 继续（断开≠取消，方案 D6）
        res.on('close', () => {
            unsubscribe();
            stopHeartbeat();
        });

        runManager.start(runId, query);
    });

    router.post('/threads/:threadId/runs/:runId/cancel', async (ctx) => {
        const { runId } = ctx.params;
        const snapshot = runManager.cancel(runId);
        if (!snapshot) {
            ctx.status = 404;
            ctx.body = { error: { code: 'run_not_found', message: `unknown runId ${runId}` } };
            return;
        }
        ctx.status = 200;
        ctx.body = {
            runId: snapshot.runId,
            status: snapshot.status === 'running' ? 'cancelling' : snapshot.status,
        };
    });

    return router;
}
