// ============================================================================
// SSE 基础设施（方案 §5.4 / AG-UI HTTP+SSE binding v1.0）
//
// - 每帧 data: 恰好一个 AG-UI 事件 JSON（@ag-ui/encoder 的 encodeSSE 负责）
// - 注释行心跳（规范允许，客户端必须容忍）
// - 客户端断开只清理本连接，不触碰 run（断开≠取消）
// ============================================================================

import type { ServerResponse } from 'node:http';
import type { Context } from 'koa';
import { EventEncoder } from '@ag-ui/encoder';

export function initSSE(ctx: Context): ServerResponse {
    // 接管原生响应：Koa 中间件链不再处理 body
    ctx.respond = false;
    ctx.status = 200;
    ctx.type = 'text/event-stream; charset=utf-8';
    ctx.set('Cache-Control', 'no-cache');
    ctx.set('X-Accel-Buffering', 'no');
    ctx.res.flushHeaders();
    return ctx.res;
}

/** 心跳：到点写注释行；返回清理函数 */
export function startHeartbeat(res: ServerResponse, intervalMs: number): () => void {
    const timer = setInterval(() => {
        if (!res.writableEnded) {
            res.write(': ka\n\n');
        }
    }, intervalMs);
    return () => clearInterval(timer);
}

/** SSE 帧写出（单个 AG-UI 事件）；eventId 非空时前置 id: 行（续传游标，
 *  标准 AG-UI 客户端按规范忽略，EventSource 类客户端可借其自动重连） */
export function writeEvent(res: ServerResponse, encoder: EventEncoder, event: unknown, eventId?: string): void {
    if (res.writableEnded || res.destroyed) return;
    const frame = encoder.encodeSSE(event as Parameters<EventEncoder['encodeSSE']>[0]);
    res.write(eventId ? `id: ${eventId}\n${frame}` : frame);
}
