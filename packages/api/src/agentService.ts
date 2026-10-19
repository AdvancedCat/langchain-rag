// ============================================================================
// agent 进程内单例（方案 §8.1 / §7.3）
//
// 向量库连接 + BM25 热启动只需构建一次；P2 起挂 ShallowRedisSaver
// checkpointer（按 thread_id 持久化 messages / /retrieved 文件 / todos，
// 支撑多轮会话与断线后继续）。构建失败不缓存失败态，下次 getAgent() 重试。
// ============================================================================

import { createRagAgent, type RagAgent } from '@langchain-rag/rag';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { getApiServerConfig } from './config.js';

export type AgentState =
    | { status: 'idle' }
    | { status: 'building' }
    | { status: 'ready'; agent: RagAgent }
    | { status: 'error'; error: string };

let agentPromise: Promise<RagAgent> | undefined;
let state: AgentState = { status: 'idle' };
let checkpointerPromise: Promise<BaseCheckpointSaver> | undefined;

/** 懒初始化 checkpointer（ShallowRedisSaver：每 thread 只留最新 checkpoint，无需时间回溯） */
export function getCheckpointer(): Promise<BaseCheckpointSaver> {
    if (!checkpointerPromise) {
        const { redisUrl, threadTtlHours } = getApiServerConfig();
        checkpointerPromise = import('@langchain/langgraph-checkpoint-redis/shallow').then(
            ({ ShallowRedisSaver }) =>
                ShallowRedisSaver.fromUrl(redisUrl, { defaultTTL: threadTtlHours * 60 }),
        );
        checkpointerPromise.catch(() => {
            // 失败不缓存：下次重试（Redis 恢复后）
            checkpointerPromise = undefined;
        });
    }
    return checkpointerPromise;
}

/** 启动预热（index.ts 调用）；幂等，重复调用返回同一构建 Promise */
export function warmupAgent(): Promise<RagAgent> {
    if (!agentPromise) {
        state = { status: 'building' };
        agentPromise = (async () => {
            const checkpointer = await getCheckpointer().catch((error) => {
                console.warn(
                    `[agent] checkpointer init failed, running WITHOUT session persistence: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                return undefined;
            });
            if (checkpointer) console.log('[agent] checkpointer ready (ShallowRedisSaver)');
            return createRagAgent({ checkpointer });
        })().then(
            (agent) => {
                state = { status: 'ready', agent };
                console.log('[agent] ready (vector store + BM25 hot-started)');
                return agent;
            },
            (error) => {
                // 失败不缓存：允许下次调用重试（如 Qdrant/Redis 启动竞态恢复后）
                agentPromise = undefined;
                state = { status: 'error', error: error instanceof Error ? error.message : String(error) };
                console.error('[agent] build failed:', state.error);
                throw error;
            },
        );
    }
    return agentPromise;
}

/** 已就绪时直接取 agent；未就绪抛错（run 执行路径应先过 /ready） */
export function getAgent(): RagAgent {
    if (state.status !== 'ready') {
        throw new Error(`agent not ready (state: ${state.status})`);
    }
    return state.agent;
}

export function getAgentState(): AgentState {
    return state;
}
