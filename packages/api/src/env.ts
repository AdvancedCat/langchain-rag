// ============================================================================
// 环境变量级联加载（必须在其他模块之前导入，靠 ESM 依赖求值顺序保证）
//
// 1. packages/api/.env        —— 服务自身配置（PORT / REDIS_URL / …）
// 2. packages/rag/.env        —— LLM / Embedding / Qdrant / 检索配置，不覆盖已设值
//
// 设计见 docs/api-service-plan.md §9.2：rag 的 .env 不搬家，两边各管各的进程配置。
// ============================================================================

import { config } from 'dotenv';

config();
config({ path: new URL('../../rag/.env', import.meta.url), override: false });
