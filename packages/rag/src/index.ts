// ============================================================================
// docs-rag-agent 库入口（barrel）
//
// 供 workspace 内其他包（packages/api）以 `docs-rag-agent` 导入；
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
