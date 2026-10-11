// ============================================================================
// Redis 实现（方案 §7.1 数据模型）
//
//   rag:thread:{id}:events   Stream   AG-UI 事件日志（entry id = 游标）
//   rag:thread:{id}:meta     Hash     会话元数据
//   rag:run:{runId}          String   run 记录（TTL 24h，诊断用）
//   rag:run:{runId}:finalized String  重启补发幂等标记
//   rag:index:threads        ZSet     updatedAt 倒序索引
// 全部 key 随写入刷新 THREAD_TTL_HOURS（缓存语义，AOF 关闭的 compose 部署一致）
// ============================================================================

import { EventType, type Event as AguiEvent, type Message } from '@ag-ui/core';
import type Redis from 'ioredis';
import type { EventRecord, Persistence, ThreadMeta } from './types.js';

const KEY = {
    events: (threadId: string) => `rag:thread:${threadId}:events`,
    meta: (threadId: string) => `rag:thread:${threadId}:meta`,
    run: (runId: string) => `rag:run:${runId}`,
    runFinalized: (runId: string) => `rag:run:${runId}:finalized`,
    index: 'rag:index:threads',
} as const;

const RUN_TTL_SECONDS = 24 * 60 * 60;
/** latestSnapshot 的倒序扫描窗口（一次 run 的典型事件量级，超限则降级为 null） */
const SNAPSHOT_SCAN_LIMIT = 500;

/** ioredis 的 stream fields 可能是扁平数组 ['e', json] 或 record，统一取字段 e */
function eventFromFields(fields: unknown): AguiEvent {
    if (Array.isArray(fields)) {
        const index = fields.findIndex((name) => name === 'e');
        return JSON.parse(String(fields[index + 1])) as AguiEvent;
    }
    return JSON.parse(String((fields as Record<string, unknown>).e)) as AguiEvent;
}

export interface RedisPersistenceOptions {
    redisUrl: string;
    threadTtlHours: number;
    /** 测试注入共享连接用 */
    client?: Redis;
}

export function createRedisPersistence(options: RedisPersistenceOptions): Persistence {
    const ttlSeconds = Math.max(1, Math.round(options.threadTtlHours * 3600));
    // 懒初始化：首次使用时建立连接（与 getRedis 分离，允许独立实例/测试注入）
    let client: Redis | null = options.client ?? null;
    let clientPromise: Promise<Redis> | null = options.client
        ? Promise.resolve(options.client)
        : null;

    const redis = async (): Promise<Redis> => {
        if (!clientPromise) {
            clientPromise = import('ioredis').then(({ default: RedisCtor }) => {
                client = new RedisCtor(options.redisUrl, {
                    lazyConnect: true,
                    maxRetriesPerRequest: 2,
                    retryStrategy: (times) => Math.min(times * 500, 5_000),
                });
                client.on('error', (error) => {
                    console.warn(`[persistence] ${error instanceof Error ? error.message : String(error)}`);
                });
                return client;
            });
        }
        const resolved = await clientPromise;
        if (resolved.status === 'wait' || resolved.status === 'end') {
            await resolved.connect();
        }
        return resolved;
    };

    const readMeta = (raw: Record<string, string> | null, threadId: string): ThreadMeta | null => {
        if (!raw || Object.keys(raw).length === 0) return null;
        return {
            threadId,
            title: raw.title === '' || raw.title === undefined ? null : raw.title,
            createdAt: Number(raw.createdAt ?? 0),
            updatedAt: Number(raw.updatedAt ?? 0),
            lastEventId: raw.lastEventId === '' || raw.lastEventId === undefined ? null : raw.lastEventId,
            messageCount: Number(raw.messageCount ?? 0),
        };
    };

    return {
        async appendEvent(threadId, event) {
            const r = await redis();
            const pipeline = r
                .multi()
                .xadd(KEY.events(threadId), '*', 'e', JSON.stringify(event))
                .hset(KEY.meta(threadId), {
                    updatedAt: String(Date.now()),
                    // lastEventId 占位，下方用真实 entry id 覆写
                    lastEventId: '',
                })
                .hsetnx(KEY.meta(threadId), 'createdAt', String(Date.now()))
                .expire(KEY.events(threadId), ttlSeconds)
                .expire(KEY.meta(threadId), ttlSeconds)
                .zadd(KEY.index, String(Date.now()), threadId);
            const results = await pipeline.exec();
            const xaddResult = results?.[0];
            if (!xaddResult || xaddResult[0]) {
                throw xaddResult?.[0] ?? new Error('XADD failed');
            }
            const eventId = String(xaddResult[1]);
            // 覆写真实游标（pipeline 内拿不到 xadd 结果，单独一次 HSET，成本可接受）
            await r.hset(KEY.meta(threadId), 'lastEventId', eventId);
            return eventId;
        },

        async readEvents(threadId, afterEventId) {
            const r = await redis();
            const key = KEY.events(threadId);
            const entries = afterEventId
                ? await r.xrange(key, `(${afterEventId}`, '+')
                : await r.xrange(key, '-', '+');
            return entries
                .filter(([id]) => id !== afterEventId)
                .map(([id, fields]) => ({ id, event: eventFromFields(fields) }));
        },

        async latestSnapshot(threadId) {
            const r = await redis();
            const entries = await r.xrevrange(KEY.events(threadId), '+', '-', 'COUNT', SNAPSHOT_SCAN_LIMIT);
            for (const [, fields] of entries.reverse()) {
                const event = eventFromFields(fields);
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                    return (event as unknown as { messages: Message[] }).messages;
                }
            }
            return null;
        },

        async ensureThread(threadId, init) {
            const r = await redis();
            const existing = readMeta(await r.hgetall(KEY.meta(threadId)), threadId);
            if (existing) {
                if (existing.title === null && init?.title !== undefined) {
                    await r.hset(KEY.meta(threadId), 'title', init.title);
                    existing.title = init.title;
                }
                return existing;
            }
            const now = Date.now();
            const fields: Record<string, string> = {
                title: init?.title ?? '',
                createdAt: String(now),
                updatedAt: String(now),
                lastEventId: '',
                messageCount: '0',
            };
            await r.hset(KEY.meta(threadId), fields);
            await r.expire(KEY.meta(threadId), ttlSeconds);
            // 入列表索引（无事件的显式建档会话也要出现在 /threads 列表里）
            await r.zadd(KEY.index, String(now), threadId);
            return readMeta(fields, threadId) ?? { threadId, title: null, createdAt: now, updatedAt: now, lastEventId: null, messageCount: 0 };
        },

        async getThread(threadId) {
            const r = await redis();
            return readMeta(await r.hgetall(KEY.meta(threadId)), threadId);
        },

        async listThreads(offset, limit) {
            const r = await redis();
            const ids = await r.zrevrange(KEY.index, offset, offset + limit - 1);
            if (ids.length === 0) return { items: [], nextOffset: null };
            const pipeline = r.multi();
            for (const id of ids) pipeline.hgetall(KEY.meta(id));
            const results = await pipeline.exec();
            const items = (results ?? [])
                .map(([err, raw], i) => (err ? null : readMeta(raw as Record<string, string>, ids[i])))
                .filter((meta): meta is ThreadMeta => meta !== null);
            const total = await r.zcard(KEY.index);
            const nextOffset = offset + ids.length < total ? offset + limit : null;
            return { items, nextOffset };
        },

        async updateMessageCount(threadId, count) {
            const r = await redis();
            await r.hset(KEY.meta(threadId), 'messageCount', String(count));
        },

        async deleteThread(threadId) {
            const r = await redis();
            const existed = (await r.exists(KEY.events(threadId), KEY.meta(threadId))) > 0;
            await r.del(KEY.events(threadId), KEY.meta(threadId));
            await r.zrem(KEY.index, threadId);
            return existed;
        },

        async createRun(runId, threadId) {
            const r = await redis();
            const record = { runId, threadId, status: 'running', startedAt: Date.now() };
            await r.set(KEY.run(runId), JSON.stringify(record), 'EX', RUN_TTL_SECONDS);
        },

        async finishRun(runId, status, error) {
            const r = await redis();
            const raw = await r.get(KEY.run(runId));
            if (!raw) return;
            const record = JSON.parse(raw) as { runId: string; threadId: string; status: string; startedAt: number };
            await r.set(
                KEY.run(runId),
                JSON.stringify({ ...record, status, endedAt: Date.now(), error }),
                'EX',
                RUN_TTL_SECONDS,
            );
        },

        async markInterruptedRuns(onInterrupt) {
            const r = await redis();
            let cursor = '0';
            const runKeys: string[] = [];
            do {
                const [next, keys] = await r.scan(cursor, 'MATCH', 'rag:run:*', 'COUNT', 100);
                cursor = next;
                runKeys.push(...keys.filter((key) => !key.endsWith(':finalized')));
            } while (cursor !== '0');

            let count = 0;
            for (const key of runKeys) {
                const raw = await r.get(key);
                if (!raw) continue;
                let record: { runId: string; threadId: string; status: string };
                try {
                    record = JSON.parse(raw);
                } catch {
                    continue;
                }
                if (record.status !== 'running') continue;
                const runId = record.runId;
                // SETNX 幂等：多个实例同时启动时只有一个能补发
                const claimed = await r.set(KEY.runFinalized(runId), '1', 'EX', RUN_TTL_SECONDS, 'NX');
                if (!claimed) continue;
                const updated = { ...record, status: 'interrupted', endedAt: Date.now() };
                await r.set(key, JSON.stringify(updated), 'EX', RUN_TTL_SECONDS);
                await onInterrupt(runId, record.threadId);
                count += 1;
            }
            return count;
        },

        async close() {
            if (client) {
                await client.quit().catch(() => client?.disconnect());
                client = null;
                clientPromise = null;
            }
        },
    };
}
