// ============================================================================
// @langchain-rag/rag 库入口（barrel）
//
// 供 workspace 内其他包（packages/api）以 `@langchain-rag/rag` 导入；
// CLI 与评测仍走各自入口（agent.ts / evals/），不经此文件。
// package.json 的 exports 直指本 TS 源——no-build 工作区约定，
// 与 packages/libs 的 main: llm-provider.ts 同一模式。
// ============================================================================

import { createRagAgent } from './retrieval/index.js';

export { createRagAgent };
export type { CreateRagAgentOptions } from './retrieval/index.js';
/** createRagAgent 返回的 deepagents agent 实例类型（服务层单例/调用侧的类型引用） */
export type RagAgent = Awaited<ReturnType<typeof createRagAgent>>;
export { getRetrievalConfig, getIngestionConfig } from './config.js';
export type { RetrievalConfig, IngestionConfig } from './config.js';

// CozeLoop 可观测（docs/cozeloop-observability-plan.md）：api 包经此导入，
// 无需直接依赖 @cozeloop/ai（OTel 单例语义要求全工程单出口，方案 §2）
export {
    initCozeLoop,
    isCozeLoopEnabled,
    shutdownCozeLoop,
    withCozeLoopSpan,
    startCozeLoopSpan,
    endCozeLoopSpan,
    failCozeLoopSpan,
    setSpanInput,
    setSpanOutput,
    setSpanError,
    truncateForSpan,
    summarizeScoredChunks,
    SpanKind,
    getLangChainTracingCallbacks,
    getCozeLoopCallbackHandler,
    CozeLoopLangChainCallbackHandler,
} from './observability/index.js';
export type { CozeLoopSpanOptions, ChunkSpanSummary, Span } from './observability/index.js';
