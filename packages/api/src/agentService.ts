// ============================================================================
// agent 进程内单例（方案 §8.1）
//
// 向量库连接 + BM25 热启动只需构建一次；构建失败不缓存失败态，
// 下次 getAgent() 重试（/ready 在此期间保持 503）。
// ============================================================================

import { createRagAgent, type RagAgent } from 'docs-rag-agent';

export type AgentState =
    | { status: 'idle' }
    | { status: 'building' }
    | { status: 'ready'; agent: RagAgent }
    | { status: 'error'; error: string };

let agentPromise: Promise<RagAgent> | undefined;
let state: AgentState = { status: 'idle' };

/** 启动预热（index.ts 调用）；幂等，重复调用返回同一构建 Promise */
export function warmupAgent(): Promise<RagAgent> {
    if (!agentPromise) {
        state = { status: 'building' };
        agentPromise = createRagAgent({}).then(
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

/** 已就绪时直接取 agent；未就绪抛错（run 执行路径在 P1 引入，届时应先过 /ready） */
export function getAgent(): RagAgent {
    if (state.status !== 'ready') {
        throw new Error(`agent not ready (state: ${state.status})`);
    }
    return state.agent;
}

export function getAgentState(): AgentState {
    return state;
}
