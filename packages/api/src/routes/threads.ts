// ============================================================================
// 会话管理 REST + 断线续传端点（方案 §5.2 / §5.3）
//
//   POST   /threads                          显式建会话（title 缺省首问回填）
//   GET    /threads?cursor=&limit=           按 updatedAt 倒序列表
//   GET    /threads/:threadId                详情 + activeRun + lastEventId
//   GET    /threads/:threadId/messages       压缩历史（最近 MESSAGES_SNAPSHOT）
//   GET    /threads/:threadId/events         SSE：先订阅 → 回放 → 去重 → 尾随
//   DELETE /threads/:threadId                删事件/元数据/checkpoint
//
// GET events 的衔接算法（§5.3）：先注册实时订阅（防回放期间丢新事件），
// 再按 afterEventId 回放，按 eventId 去重后切入实时尾随；
// 回放完成且无活跃 run（或已见终态）即关流。
// ============================================================================

import { randomUUID } from 'node:crypto';
import Router from '@koa/router';
import { EventEncoder } from '@ag-ui/encoder';
import { EventType, type Event as AguiEvent } from '@ag-ui/core';
import type { RunManager } from '../runManager.js';
import type { Persistence } from '../persistence/types.js';
import { initSSE, startHeartbeat, writeEvent } from '../sse.js';
import { getCheckpointer } from '../agentService.js';

export interface ThreadsRouterDeps {
    runManager: RunManager;
    persistence: Persistence;
    sseHeartbeatMs: number;
}

function isTerminal(type: unknown): boolean {
    return type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR;
}

export function createThreadsRouter({ runManager, persistence, sseHeartbeatMs }: ThreadsRouterDeps): Router {
    const router = new Router();

    router.post('/threads', async (ctx) => {
        const body = (ctx.request.body ?? {}) as { title?: unknown };
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
        const threadId = randomUUID();
        const meta = await persistence.ensureThread(threadId, { title });
        ctx.status = 201;
        ctx.body = meta;
    });

    router.get('/threads', async (ctx) => {
        const limitRaw = Number(ctx.query.limit ?? 20);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
        const cursorRaw = Number(ctx.query.cursor ?? 0);
        const offset = Number.isInteger(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0;

        const { items, nextOffset } = await persistence.listThreads(offset, limit);
        ctx.body = {
            items: items.map((meta) => ({
                threadId: meta.threadId,
                title: meta.title,
                updatedAt: meta.updatedAt,
                messageCount: meta.messageCount,
                activeRun: runManager.getActiveRunByThread(meta.threadId),
            })),
            nextCursor: nextOffset,
        };
    });

    router.get('/threads/:threadId', async (ctx) => {
        const meta = await persistence.getThread(ctx.params.threadId);
        if (!meta) {
            ctx.status = 404;
            ctx.body = { error: { code: 'thread_not_found', message: `unknown thread ${ctx.params.threadId}` } };
            return;
        }
        ctx.body = {
            ...meta,
            activeRun: runManager.getActiveRunByThread(meta.threadId),
        };
    });

    router.get('/threads/:threadId/messages', async (ctx) => {
        const meta = await persistence.getThread(ctx.params.threadId);
        if (!meta) {
            ctx.status = 404;
            ctx.body = { error: { code: 'thread_not_found', message: `unknown thread ${ctx.params.threadId}` } };
            return;
        }
        const messages = await persistence.latestSnapshot(ctx.params.threadId);
        ctx.body = { messages: messages ?? [] };
    });

    router.delete('/threads/:threadId', async (ctx) => {
        const existed = await persistence.deleteThread(ctx.params.threadId);
        if (!existed) {
            ctx.status = 404;
            ctx.body = { error: { code: 'thread_not_found', message: `unknown thread ${ctx.params.threadId}` } };
            return;
        }
        // checkpoint 一并清理（agent 未就绪/无 checkpointer 时跳过）
        try {
            const checkpointer = await getCheckpointer();
            if (typeof (checkpointer as { deleteThread?: unknown }).deleteThread === 'function') {
                await (checkpointer as { deleteThread: (id: string) => Promise<void> }).deleteThread(ctx.params.threadId);
            }
        } catch (error) {
            console.warn(`[threads] checkpoint cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        ctx.status = 204;
    });

    // ---- 断线续传端点 ----
    router.get('/threads/:threadId/events', async (ctx) => {
        const { threadId } = ctx.params;
        const meta = await persistence.getThread(threadId);
        if (!meta) {
            ctx.status = 404;
            ctx.body = { error: { code: 'thread_not_found', message: `unknown thread ${threadId}` } };
            return;
        }
        const queryAfter = ctx.query.afterEventId;
        const afterEventId =
            (typeof queryAfter === 'string' && queryAfter !== '' ? queryAfter : undefined) ??
            (ctx.get('Last-Event-ID') || undefined);

        const res = initSSE(ctx);
        const encoder = new EventEncoder();
        const stopHeartbeat = startHeartbeat(res, sseHeartbeatMs);

        let closed = false;
        const sent = new Set<string>();
        const pending = new Map<string, AguiEvent>();
        let replayDone = false;

        const finish = () => {
            if (closed) return;
            closed = true;
            stopHeartbeat();
            unsubscribe();
            if (!res.writableEnded) res.end();
        };

        const deliver = (event: AguiEvent, eventId: string) => {
            if (closed) return;
            if (!replayDone) {
                // 回放期间先缓冲（eventId 为空的降级事件无法去重，直接透传）
                if (eventId) pending.set(eventId, event);
                else writeEvent(res, encoder, event);
                return;
            }
            if (eventId && sent.has(eventId)) return;
            if (eventId) sent.add(eventId);
            writeEvent(res, encoder, event, eventId || undefined);
            if (isTerminal(event.type)) finish();
        };

        const unsubscribe = runManager.subscribeThread(threadId, deliver);
        res.on('close', () => {
            // 客户端断开：仅退订（run 不受影响）
            if (!closed) {
                closed = true;
                stopHeartbeat();
                unsubscribe();
            }
        });

        // 回放（afterEventId=0 与缺省语义相同：全量）
        const records = await persistence.readEvents(threadId, afterEventId === '0' ? undefined : afterEventId);
        if (closed) return;
        for (const record of records) {
            sent.add(record.id);
            writeEvent(res, encoder, record.event, record.id);
        }
        replayDone = true;

        // 冲刷回放期间实时到达的事件（deliver 统一处理去重与终态关流）
        for (const [eventId, event] of pending) {
            deliver(event, eventId);
        }
        pending.clear();
        if (closed) return;

        // 收尾判定：回放尾部已是终态，或无活跃 run → 发完即关流；否则尾随至终态
        const last = records.at(-1);
        const active = runManager.getActiveRunByThread(threadId);
        if (isTerminal(last?.event.type) || !active) {
            finish();
        }
    });

    return router;
}
