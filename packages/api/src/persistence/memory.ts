// ============================================================================
// 内存实现：单测 fake + 接口契约参照（不具备跨进程持久性）
// ============================================================================

import { EventType, type Event as AguiEvent, type Message } from '@ag-ui/core';
import type { EventRecord, Persistence, ThreadMeta } from './types.js';

interface ThreadState {
    meta: ThreadMeta;
    events: EventRecord[];
}

export function createMemoryPersistence(): Persistence {
    const threads = new Map<string, ThreadState>();
    const runs = new Map<string, { runId: string; threadId: string; status: string; startedAt: number }>();
    let seq = 0;

    const stateOf = (threadId: string): ThreadState => {
        let state = threads.get(threadId);
        if (!state) {
            state = {
                meta: {
                    threadId,
                    title: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    lastEventId: null,
                    messageCount: 0,
                },
                events: [],
            };
            threads.set(threadId, state);
        }
        return state;
    };

    return {
        async appendEvent(threadId, event) {
            const state = stateOf(threadId);
            seq += 1;
            const id = `${Date.now()}-${seq}`;
            state.events.push({ id, event });
            state.meta.lastEventId = id;
            state.meta.updatedAt = Date.now();
            return id;
        },

        async readEvents(threadId, afterEventId) {
            const state = threads.get(threadId);
            if (!state) return [];
            if (!afterEventId) return [...state.events];
            const index = state.events.findIndex((record) => record.id === afterEventId);
            if (index < 0) return [...state.events];
            return state.events.slice(index + 1);
        },

        async latestSnapshot(threadId) {
            const state = threads.get(threadId);
            if (!state) return null;
            for (let i = state.events.length - 1; i >= 0; i--) {
                const event = state.events[i].event;
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                    return (event as unknown as { messages: Message[] }).messages;
                }
            }
            return null;
        },

        async ensureThread(threadId, init) {
            const state = stateOf(threadId);
            if (state.meta.title === null && init?.title !== undefined) {
                state.meta.title = init.title;
            }
            return { ...state.meta };
        },

        async getThread(threadId) {
            const state = threads.get(threadId);
            return state ? { ...state.meta } : null;
        },

        async listThreads(offset, limit) {
            const sorted = [...threads.values()]
                .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
                .map((state) => ({ ...state.meta }));
            const items = sorted.slice(offset, offset + limit);
            const nextOffset = offset + items.length < sorted.length ? offset + limit : null;
            return { items, nextOffset };
        },

        async updateMessageCount(threadId, count) {
            const state = threads.get(threadId);
            if (state) state.meta.messageCount = count;
        },

        async deleteThread(threadId) {
            const existed = threads.delete(threadId);
            for (const [runId, run] of runs) {
                if (run.threadId === threadId) runs.delete(runId);
            }
            return existed;
        },

        async createRun(runId, threadId) {
            runs.set(runId, { runId, threadId, status: 'running', startedAt: Date.now() });
        },

        async finishRun(runId, status, error) {
            const run = runs.get(runId);
            if (run) {
                run.status = status;
                void error;
            }
        },

        async markInterruptedRuns(onInterrupt) {
            let count = 0;
            for (const [runId, run] of [...runs.entries()]) {
                if (run.status === 'running') {
                    run.status = 'interrupted';
                    await onInterrupt(runId, run.threadId);
                    count += 1;
                }
            }
            return count;
        },

        async close() {
            // no-op
        },
    };
}
