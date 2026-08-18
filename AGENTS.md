# AGENTS.md — langchain-rag

面向 AI 编码代理的项目指南。人类工程师也可将其作为快速上手文档。

## 项目概览

pnpm（`pnpm@10.7.0`）monorepo，TypeScript ESM（`"type": "module"`）。基于 LangChain / Deep Agents 的生产级 RAG 文档问答 Agent。

| 目录 | 包名 | 说明 |
|---|---|---|
| `packages/rag` | `docs-rag-agent` | 主应用：文档索引 + 混合检索 + 评测工具链 |
| `packages/libs` | `@langchain-rag/shared` | 跨包共享的 LLM provider 工厂（`llm-provider.ts`） |

## 常用命令

```bash
# 根目录
pnpm install              # 安装依赖
pnpm typecheck            # 递归 tsc --noEmit
pnpm test                 # 递归 vitest run（当前 171 个用例，必须全绿）
pnpm rag                  # 启动 RAG agent（交互问答）
pnpm rag:index            # 仅构建/更新向量索引

# packages/rag（也可用 make <target>，见其 Makefile）
make infra-up             # docker compose 启动 Qdrant（localhost:6333）
make env                  # 从 .env.example 复制 .env
pnpm index                # 索引文档（--index-only）
pnpm eval                 # 检索评测（文本报告）；eval:json / eval:rebuild
pnpm eval:gen             # 生成评测（faithfulness/relevance）
make eval STRATEGY=hybrid-rewrite TOP_K=4   # 带参数评测，详见 make help
```

改动代码后的最低验证门槛：`pnpm typecheck && pnpm test`。

## 环境与外部依赖

- 运行前需要 `packages/rag/.env`（由 `.env.example` 复制）：`DEEPSEEK_API_KEY`（Chat/Query Rewrite）、`DASHSCOPE_API_KEY`（embedding `qwen3.7-text-embedding`、rerank）、`QDRANT_URL`/`QDRANT_COLLECTION`。
- 向量库 **Qdrant**，选型决策见 `packages/rag/docs/vector-db-selection-report.md`。默认 collection `langchain_docs_mdheader`（`md-header-v2` 切分，2858 chunks）。
- 检索参数统一走 `RETRIEVAL_*` 环境变量 → `packages/rag/src/config.ts` 的 `RetrievalConfig`，不要在代码里硬编码。

## 架构速览（packages/rag/src）

```
agent.ts            入口：交互问答 / --index-only 索引
chunking/           切分管道：Loader → TypeDetector → SplitterRegistry
                    → Splitter(markdown/plaintext) → ChunkValidator
                    统一 Chunk 契约（schema.ts，zod），CHUNKER_VERSION 守卫
ingestion/          取数 → 切分 → embedding → Qdrant upsert + BM25 构建
vectorStore.ts      Qdrant 封装、BM25 热启动重建、--rebuild 守卫
retrieval/          检索管线：pipeline.ts（策略编排）
                    retrievers/（dense、bm25） transformers/（rewrite、multi-query）
                    rerankers/（DashScope qwen3-rerank，实验性，默认关闭）
evals/              检索+生成评测；datasets/ 数据集；baselines/ 冻结基线
```

当前生产默认：**hybrid-rewrite**（Dense + BM25 Boost Fusion + Query Rewrite）+ **md-header-v2** 切分（header 深度 2）。演进历史见 `packages/rag/Milestone.md`。

## 开发约定

- **Commit 规范**：Conventional Commits，scope 用包/模块名，如 `feat(rag):`、`docs(rag/evals):`、`test(rag):`；中英文均可，正文说清动机与结果。
- **文档语言**：设计文档用中文，与 `packages/rag/docs/` 现有文档一致。
- **测试**：Vitest，优先为纯函数（BM25/fusion/MMR/metrics/chunking）写单测；`__tests__/` 就近放在模块目录下。
- **计划先行**：重要迭代先在 `packages/rag/docs/` 落计划文档（plan），实施后**回填结果与评测数据**到该文档（参照 `chunking-pipeline-plan.md` §6 的格式）。

## 评测与变更纪律（重要）

1. **Baseline 一经冻结不再修改**：`evals/baselines/` 下的基准结果只增不改，所有策略优化与冻结基线对比。
2. **检索/切分策略变更必须 A/B 验证**：同策略对照、指标过 gate（不得退化 Hit@4/MRR/Precision 等主指标）才可设为生产默认；负结果也要写入计划文档与 Milestone，写明原因（参照 Phase 1 / Phase 3 的记录方式）。
3. **切分策略变更必须 `--rebuild`**：`chunkerVersion` 热启动守卫会检测并提示；评测数据写入 `evals/results/`，报告更新 `evals/baselines/README.md`。
4. **同步维护 `packages/rag/Milestone.md`**：发生重要特性变更（新检索策略、切分/索引契约变更、评测基线更新、架构级重构等）时，必须在同一变更中追加里程碑记录。
