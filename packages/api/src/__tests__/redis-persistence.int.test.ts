// ============================================================================
// Redis 持久化集成测试：要求本地 Redis（docker compose）。不可达时整组跳过。
// key 全部使用随机 threadId/runId，避免污染真实会话数据。
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { EventType, type Event as AguiEvent } from '@ag-ui/core';
import { createRedisPersistence } from '../persistence/redis.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let client: Redis | null = null;

beforeAll(async () => {
    try {
        client = new Redis(REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null,
            connectTimeout: 1_000,
        });
        await client.connect();
    } catch {
        client = null;
    }
});

afterAll(async () => {
    if (client) {
        await client.quit().catch(() => client?.disconnect());
        client = null;
    }
});

function runIfRedis<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
    return async () => {
        if (!client) {
            console.warn('[int] Redis 不可达，跳过集成测试组');
            return undefined;
        }
        return fn();
    };
}

const ev = (type: AguiEvent['type'], extra: Record<string, unknown> = {}): AguiEvent =>
    ({ type, timestamp: Date.now(), ...extra }) as AguiEvent;

describe('RedisPersistence（集成）', () => {
    it(
        'appendEvent/readEvents：全量与游标增量，id 唯一递增',
        runIfRedis(async () => {
            const persistence = createRedisPersistence({ redisUrl: REDIS_URL, threadTtlHours: 1 });
            const threadId = crypto.randomUUID();
            try {
                const ids: string[] = [];
                for (let i = 0; i < 5; i++) {
                    ids.push(await persistence.appendEvent(threadId, ev(EventType.TEXT_MESSAGE_CONTENT, { delta: `t${i}` })));
                }
                const all = await persistence.readEvents(threadId);
                expect(all).toHaveLength(5);
                expect(all.map((r) => r.id)).toEqual(ids);
                expect(new Set(ids).size).toBe(5);

                const incremental = await persistence.readEvents(threadId, ids[2]);
                expect(incremental.map((r) => (r.event as { delta: string }).delta)).toEqual(['t3', 't4']);

                const meta = await persistence.getThread(threadId);
                expect(meta?.lastEventId).toBe(ids.at(-1));
                expect(meta?.updatedAt).toBeGreaterThan(0);
            } finally {
                await persistence.deleteThread(threadId);
                await persistence.close();
            }
        }),
    );

    it(
        'latestSnapshot：倒序扫描最近 MESSAGES_SNAPSHOT',
        runIfRedis(async () => {
            const persistence = createRedisPersistence({ redisUrl: REDIS_URL, threadTtlHours: 1 });
            const threadId = crypto.randomUUID();
            try {
                await persistence.appendEvent(threadId, ev(EventType.TEXT_MESSAGE_CONTENT, { delta: 'x' }));
                await persistence.appendEvent(
                    threadId,
                    ev(EventType.MESSAGES_SNAPSHOT, { messages: [{ id: 'a', role: 'user', content: 'q' }] }),
                );
                await persistence.appendEvent(threadId, ev(EventType.RUN_FINISHED, { threadId, runId: 'r' }));
                const messages = await persistence.latestSnapshot(threadId);
                expect(messages).toEqual([{ id: 'a', role: 'user', content: 'q' }]);
            } finally {
                await persistence.deleteThread(threadId);
                await persistence.close();
            }
        }),
    );

    it(
        'ensureThread/listThreads/updateMessageCount/deleteThread 全链路',
        runIfRedis(async () => {
            const persistence = createRedisPersistence({ redisUrl: REDIS_URL, threadTtlHours: 1 });
            const threadId = crypto.randomUUID();
            try {
                const created = await persistence.ensureThread(threadId);
                expect(created.title).toBeNull();

                // title 回填（已存在且为 null）
                const backfilled = await persistence.ensureThread(threadId, { title: '标题' });
                expect(backfilled.title).toBe('标题');

                // 二次 ensure 不覆盖已有 title
                const again = await persistence.ensureThread(threadId, { title: '别的' });
                expect(again.title).toBe('标题');

                await persistence.updateMessageCount(threadId, 7);
                const { items } = await persistence.listThreads(0, 100);
                const found = items.find((meta) => meta.threadId === threadId);
                expect(found).toMatchObject({ title: '标题', messageCount: 7 });

                expect(await persistence.deleteThread(threadId)).toBe(true);
                expect(await persistence.getThread(threadId)).toBeNull();
                expect(await persistence.deleteThread(threadId)).toBe(false);
            } finally {
                await persistence.deleteThread(threadId);
                await persistence.close();
            }
        }),
    );

    it(
        'run 记录：createRun → finishRun；markInterruptedRuns 幂等（SETNX）',
        runIfRedis(async () => {
            const persistence = createRedisPersistence({ redisUrl: REDIS_URL, threadTtlHours: 1 });
            const runId = crypto.randomUUID();
            const threadId = crypto.randomUUID();
            try {
                await persistence.createRun(runId, threadId);

                const interrupted: Array<{ runId: string; threadId: string }> = [];
                const first = await persistence.markInterruptedRuns(async (rid, tid) => {
                    interrupted.push({ runId: rid, threadId: tid });
                    await persistence.appendEvent(tid, ev(EventType.RUN_ERROR, { message: 'restart', code: 'server_restart' }));
                });
                expect(first).toBeGreaterThanOrEqual(1);
                expect(interrupted.some((r) => r.runId === runId)).toBe(true);

                // thread 日志里已补发 RUN_ERROR{server_restart}
                const events = await persistence.readEvents(threadId);
                expect(events.at(-1)?.event).toMatchObject({ type: 'RUN_ERROR', code: 'server_restart' });

                // 幂等：本 run 已非 running，二次扫描不重复处理
                // （Redis 里可能残留其他历史 stale run，二次扫描对它们处理是预期行为）
                const secondInterrupted: string[] = [];
                await persistence.markInterruptedRuns(async (rid) => {
                    secondInterrupted.push(rid);
                });
                expect(secondInterrupted).not.toContain(runId);
                expect(interrupted.filter((r) => r.runId === runId)).toHaveLength(1);
            } finally {
                await persistence.deleteThread(threadId);
                await client!.del(`rag:run:${runId}`, `rag:run:${runId}:finalized`);
                await persistence.close();
            }
        }),
    );
});
