# langchain-lib

> 基于 LangChain Deep Agents 的**生产级 RAG Agent** — 混合检索（Dense + BM25）、Query Rewrite、Cross-encoder Rerank，并内置完整的离线评测体系。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![LangChain](https://img.shields.io/badge/LangChain-1.x-1C3C3C?logo=langchain&logoColor=white)](https://js.langchain.com/)
[![Qdrant](https://img.shields.io/badge/Qdrant-Vector%20DB-FF9900?logo=qdrant&logoColor=white)](https://qdrant.tech/)

---

## 目录

- [特性](#特性)
- [架构概览](#架构概览)
- [评测结果](#评测结果)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [配置说明](#配置说明)
- [评测体系](#评测体系)
- [技术栈](#技术栈)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## 特性

- **🔀 Hybrid Search** — Dense 向量检索 + 纯内存 BM25 稀疏检索，采用 Score-level Boost Fusion 融合策略（dense-first，BM25 仅做 boost 不引入新文档），兼顾语义召回与关键词精确匹配。
- **✍️ Query Transformation** — 基于 DeepSeek 的 Query Rewrite（LRU 缓存 500 条，失败自动 fallback 原查询），并提供 Multi-Query 生成能力。
- **🎯 Cross-encoder Rerank** — 两阶段检索架构：Bi-encoder 粗筛（~2700 → 20），Cross-encoder 精排（20 → 4）。通用 `Reranker` 接口，默认接入 DashScope `qwen3-rerank`，可替换为任意 reranker。
- **🧠 Deep Agents 架构** — 实现 **Retrieve → Offload → Delegate** 三步工作流：检索到的 chunks offload 到 StateBackend 文件系统，由并行子 Agent（chunk-analyst）独立分析，避免主 Agent 上下文膨胀。
- **🚫 Abstention（拒答）** — 基于 cosine score 阈值（默认 0.78，`RETRIEVAL_ABSTENTION_THRESHOLD` 可配）识别无答案问题，避免"自信地犯错"。生产配置下 7/7 unanswerable query 全部正确拒答。
- **🧪 内置离线评测** — Retrieval（Hit@K / MRR / NDCG / Precision / Keyword Recall / Duplicate Ratio）与 Generation（Faithfulness + Relevance）双维度评测，支持 baseline 冻结与 A/B 对比。
- **🇨🇳 中英文混合场景** — 中文 Query over English Docs，Python 文档作为 cross-language hard negative，专门评测检索策略的抗噪与消歧能力。
- **⚙️ 严格工程规范** — TypeScript `strict: true`、环境变量边界校验、Makefile 命令封装、docker-compose 一键启动基础设施。

---

## 架构概览

```
用户提问
  │
  ▼
┌─────────────────────────────────────────────┐
│  Query Transform（可选）                      │
│  Rewrite / Multi-Query（LRU Cache + Fallback）│
└───────────────────┬─────────────────────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
  Dense Retrieval     BM25 Sparse Retrieval
  (Qdrant, top 30)    (In-memory, top 5)
          └─────────┬─────────┘
                    ▼
        Score-level Boost Fusion
        (dense × 2.0 + sparse × 0.5)
                    │
                    ▼
        Rerank（可选，Cross-encoder）
        top-fetchK 20 → top 4
                    │
                    ▼
  search_documentation tool（top 4 chunks）
                    │
                    ▼
  StateBackend（Offload 到文件系统，避免上下文膨胀）
                    │
                    ▼
  chunk-analyst × N（并行子 Agent 独立分析）
                    │
                    ▼
  主 Agent 综合回答（含来源引用）
```

---

## 评测结果

在 44 条 golden query（37 answerable + 7 unanswerable）上的检索评测：

| 策略 | Hit@4 | Hit@10 | MRR | NDCG@10 | Abstention |
|------|-------|--------|-----|---------|------------|
| baseline-dense | 89.2% | 94.6% | 0.652 | 0.380 | 85.7% |
| hybrid-bm25 | **91.9%** | 94.6% | **0.662** | 0.381 | 85.7% |
| **hybrid-rewrite（生产默认）** | 89.2% | **97.3%** | 0.684 | **0.393** | **100%** |
| hybrid-rerank（实验性） | 89.2% | 97.3% | 0.683 | 0.390 | 100% |

**核心结论**：

- **hybrid-rewrite** 是生产默认配置 — Abstention 达到完美 100%，Hit@20=100% 深度召回无遗漏，Duplicate Ratio 最低（8.8%）。
- **hybrid-bm25** 在 top-4 精度上最优（Hit@4=91.9%），适合追求精确匹配的场景。
- 详细的消融实验、失败分析与策略 trade-off 见 [baselines/README.md](packages/rag/evals/baselines/README.md)。

---

## 快速开始

### 环境要求

- Node.js ≥ 18
- pnpm ≥ 10
- Docker（用于启动 Qdrant）
- DeepSeek API Key（Chat 模型）
- DashScope API Key（Embedding + Rerank）

### 1. 克隆并安装依赖

```bash
git clone https://github.com/advancedcat/langchain-lib.git
cd langchain-lib
pnpm install
```

### 2. 配置环境变量

```bash
cd packages/rag
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY 和 DASHSCOPE_API_KEY
```

必须配置：

- `DEEPSEEK_API_KEY` — [DeepSeek](https://platform.deepseek.com/) Chat 模型 API Key
- `DASHSCOPE_API_KEY` — [阿里云 DashScope](https://platform.qianwenai.com/home/api-keys) Embedding API Key

### 3. 启动 Qdrant 向量数据库

```bash
# 在 packages/rag 目录下
make infra-up
# 或 docker compose up -d
```

Qdrant 会监听在 `http://localhost:6333`。

### 4. 索引文档 + 启动问答

```bash
# 一键运行：索引文档 + 问答
pnpm run rag:index   # 仅索引文档
pnpm run rag         # 启动交互式问答
```

默认索引 58 篇 LangChain / deepagents / LangGraph 文档（JS + Python），共约 2700 chunks。

---

## 项目结构

Monorepo 使用 pnpm workspace 管理：

```
langchain-lib/
├── packages/
│   ├── rag/                        # 📦 核心 RAG Agent 包
│   │   ├── src/
│   │   │   ├── agent.ts            # 主入口：CLI + 流式事件渲染
│   │   │   ├── config.ts           # 环境变量解析与边界校验
│   │   │   ├── embeddings.ts       # 千问 Embedding 工厂
│   │   │   ├── vectorStore.ts      # Qdrant 向量存储（连接/索引/重建）
│   │   │   ├── ingestion/          # 📥 离线索引链路
│   │   │   │   └── index.ts        #   文档抓取 → 切分 → Embedding → 索引
│   │   │   └── retrieval/          # 🔍 在线召回链路
│   │   │       ├── index.ts        #   RAG Agent 构建
│   │   │       ├── pipeline.ts     #   检索管线编排（融合/截断）
│   │   │       ├── types.ts        #   共享类型
│   │   │       ├── retrievers/     #   Dense / BM25 / Hybrid 检索器
│   │   │       ├── transformers/   #   Query Rewrite / Multi-Query
│   │   │       └── rerankers/      #   Cross-encoder Reranker 接口
│   │   ├── evals/                  # 🧪 离线评测
│   │   │   ├── retrieval/          #   检索评测
│   │   │   ├── generation/         #   生成评测（Faithfulness/Relevance）
│   │   │   ├── datasets/           #   Golden query 数据集
│   │   │   └── baselines/          #   冻结的基准结果
│   │   ├── docs/                   # 设计文档
│   │   ├── Makefile                # 开发/评测命令入口
│   │   ├── docker-compose.yml      # 本地 Qdrant
│   │   └── .env.example
│   └── libs/                       # 📦 跨包共享工具
│       └── llm-provider.ts         #   统一 LLM 工厂
├── LICENSE
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## 配置说明

所有配置通过环境变量管理，核心配置项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | — | **必填**，DeepSeek Chat 模型 API Key |
| `DASHSCOPE_API_KEY` | — | **必填**，千问 Embedding API Key |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant 地址 |
| `QDRANT_COLLECTION` | `langchain_docs` | Qdrant collection 名称 |
| `RETRIEVAL_TOP_K` | `4` | 最终返回的 chunk 数 |
| `RETRIEVAL_FETCH_K` | `20` | 粗筛候选数 |
| `RETRIEVAL_HYBRID_ENABLED` | `true` | 是否启用混合检索 |
| `RETRIEVAL_DENSE_WEIGHT` | `2` | Dense 检索融合权重 |
| `RETRIEVAL_SPARSE_WEIGHT` | `0.5` | BM25 检索融合权重 |
| `RETRIEVAL_QUERY_REWRITE` | `true` | 是否启用 Query Rewrite |
| `RETRIEVAL_RERANK_ENABLED` | `false` | 是否启用 Cross-encoder Rerank |
| `RETRIEVAL_MMR_ENABLED` | `false` | 是否启用 MMR（与 Rerank 互斥） |

完整配置见 [packages/rag/.env.example](packages/rag/.env.example) 和 [packages/rag/src/config.ts](packages/rag/src/config.ts)。

---

## 评测体系

项目内置两套离线评测，通过 Makefile 触发：

```bash
cd packages/rag

# 检索评测（不调用 Chat LLM，纯检索）
make eval                                    # 文本报告
make eval STRATEGY=hybrid-bm25 K=30 TOP_K=8  # 自定义策略与参数
make eval-json                               # JSON 输出
make eval-rebuild                            # 强制重建索引后评测

# 生成评测（检索 → 生成 → Faithfulness + Relevance）
make eval-gen
make eval-gen LIMIT=5 SAVE=my-baseline.json
```

支持的检索策略：

- `baseline-dense` — 纯向量相似度
- `hybrid-bm25` — Dense + BM25 Boost Fusion
- `hybrid-rewrite` — Dense + BM25 + Query Rewrite（**生产默认**）
- `hybrid-rerank` — 在 hybrid-rewrite 基础上叠加 Cross-encoder Rerank
- `threshold-mmr` — 阈值过滤 + MMR 多样性选择

评测指标定义与 baseline 对比详见 [evals/baselines/README.md](packages/rag/evals/baselines/README.md)。

---

## 技术栈

| 层 | 选型 |
|----|------|
| Agent 框架 | [deepagents](https://www.npmjs.com/package/deepagents) v1.x + LangChain 1.x |
| 编排运行时 | LangGraph（subagent streaming / StateBackend） |
| 向量存储 | [Qdrant](https://qdrant.tech/)（本地 Docker 部署） |
| Embedding | 千问 `qwen3.7-text-embedding`（DashScope OpenAI 兼容模式，1024 维） |
| Chat 模型 | DeepSeek `deepseek-v4-flash`（OpenAI 兼容 API） |
| Rerank | DashScope `qwen3-rerank`（Cross-encoder，可插拔） |
| 稀疏检索 | 纯内存 BM25（中文 unigram + 英文驼峰/连字符拆分） |
| 文档切分 | `RecursiveCharacterTextSplitter`（chunk 1000, overlap 200） |
| 运行时 | Node.js + tsx（TypeScript native ESM） |
| 包管理 | pnpm workspace |

---

## Roadmap

- [ ] **Metadata 路由** — 基于 `language` / `module` 元数据预过滤，解决跨语言与跨包混淆问题
- [ ] **Reranker 模型升级** — 接入 bge-reranker-v2-m3 或中文微调 reranker，替换当前效果未达预期的 qwen3-rerank
- [ ] **BM25 索引优化** — 流式增量构建 / 紧凑数据结构，支持 100k+ chunks 无 OOM；长期迁移至 Qdrant native sparse vectors
- [ ] **单元测试** — 引入 Vitest，覆盖 retrievers / fusion / config parsing
- [ ] **CI/CD** — GitHub Actions（typecheck / lint / test）
- [ ] **可观测性** — LangSmith tracing 集成文档与最佳实践

---

## Contributing

Contributions are welcome! 如果你发现 bug 或有改进建议，欢迎提交 issue 或 PR。

1. Fork 本仓库
2. 创建你的特性分支（`git checkout -b feature/amazing-feature`）
3. 提交你的改动（`git commit -m 'feat: add amazing feature'`，遵循 Conventional Commits）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 开启一个 Pull Request

提交前请确保 `pnpm typecheck` 通过。

---

## License

本项目基于 [MIT License](./LICENSE) 开源。
