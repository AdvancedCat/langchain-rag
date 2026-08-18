# langchain-rag

> 基于 LangChain Deep Agents 的**生产级 RAG Agent** — 混合检索（Dense + BM25）、Query Rewrite、Markdown 结构化切分（`md-header-v2`），并内置完整的离线评测体系（Cross-encoder Rerank 框架已就绪，实验性、默认关闭）。

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
- [迭代历史](#迭代历史)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## 特性

- **🔀 Hybrid Search** — Dense 向量检索 + 纯内存 BM25 稀疏检索，采用 Score-level Boost Fusion 融合策略（dense-first，BM25 仅做 boost 不引入新文档），兼顾语义召回与关键词精确匹配。
- **✍️ Query Transformation** — 基于 DeepSeek 的 Query Rewrite（temperature 0.1，LRU 缓存 500 条，失败自动 fallback 原查询），并提供 Multi-Query 生成能力。
- **🧩 结构化切分管道** — `Loader → TypeDetector → SplitterRegistry → Splitter → ChunkValidator` 插件化管道；统一 Chunk 契约（zod 校验，确定性 id / contentHash）；自研 Markdown header 切分核 `md-header-v2`（默认 h1-h2，超长 section 字符级二级切分），`sectionPath` 上下文在 embedding / BM25 / rerank 消费侧统一注入。
- **🎯 Cross-encoder Rerank（实验性，默认关闭）** — 两阶段检索架构：Bi-encoder 粗筛（~2900 → 20），Cross-encoder 精排（20 → 4）。通用 `Reranker` 接口，已接入 DashScope `qwen3-rerank`；A/B 验证未带来净增益，保留框架待更优模型。
- **🧠 Deep Agents 架构** — 实现 **Retrieve → Offload → Delegate** 三步工作流：检索到的 chunks offload 到 StateBackend 文件系统，由并行子 Agent（chunk-analyst）独立分析，避免主 Agent 上下文膨胀。
- **🚫 Abstention（拒答）** — 基于 cosine score 阈值（默认 0.78，`RETRIEVAL_ABSTENTION_THRESHOLD` 可配）识别无答案问题，避免"自信地犯错"。生产配置下 7/7 unanswerable query 全部正确拒答。
- **🧪 内置离线评测** — Retrieval（Hit@K / MRR / NDCG / Precision / Keyword Recall / Duplicate Ratio）与 Generation（Faithfulness + Relevance）双维度评测，支持 baseline 冻结与 A/B 对比。
- **🇨🇳 中英文混合场景** — 中文 Query over English Docs，Python 文档作为 cross-language hard negative，专门评测检索策略的抗噪与消歧能力。
- **⚙️ 严格工程规范** — TypeScript `strict: true`、环境变量边界校验、Vitest 单元测试（171 用例，纯函数全覆盖）、Makefile 命令封装、docker-compose 一键启动基础设施。

---

## 架构概览

**离线索引链路**：

```
Loader（抓取 58 篇文档）
  → TypeDetector（declaredType > magic bytes > MIME > 文本嗅探）
  → SplitterRegistry → MarkdownSplitter（md-header-v2，h1-h2）
  → ChunkValidator（契约守门：id/contentHash/chunkIndex 连续性）
  → Embedding（qwen3.7-text-embedding，1024 维）
  → Qdrant upsert（2858 chunks）+ BM25 内存索引构建
```

**在线检索链路**：

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
        Rerank（可选，Cross-encoder，默认关闭）
        top-fetchK 20 → top 4
                    │
                    ▼
  search_documentation tool（top 4 chunks，
  消费侧统一注入 sectionPath 上下文）
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

| 策略 | 切分 | Hit@4 | Hit@10 | Prec@4 | MRR | NDCG@10 | Abstention |
|------|------|-------|--------|--------|-----|---------|------------|
| baseline-dense | 字符级（旧） | 89.2% | 94.6% | 41.2% | 0.652 | 0.380 | 85.7% |
| hybrid-bm25 | 字符级（旧） | **91.9%** | 94.6% | 40.5% | 0.662 | 0.381 | 85.7% |
| hybrid-rewrite | 字符级（旧） | 91.9% | 97.3% | 41.2% | **0.684** | 0.393 | **100%** |
| hybrid-rerank（实验性） | 字符级（旧） | 89.2% | 97.3% | 39.9% | 0.683 | 0.390 | **100%** |
| **hybrid-rewrite（生产默认）** | **md-header-v2** | 91.9% | **100%** | **47.3%** | 0.673 | **0.427** | **100%** |

**核心结论**：

- 当前生产配置 = **hybrid-rewrite + md-header-v2 切分**（2858 chunks）：Hit@10 达到 100% 深度召回无遗漏，Precision@4 较旧切分提升 6pp（41.2% → 47.3%），Abstention 保持完美 100%。
- 切分管道 A/B 中 md-header-v2 首轮 Hit@4 94.6%，复跑 91.9%（Query Rewrite 的 LLM 波动 ±1 query），Hit@10 / Prec@4 / Abstention 稳定，通过 gate 成为默认。
- Rerank 消融实验证明 `qwen3-rerank` 在当前语料上无净增益（Rerank Drift + 模型偏差），默认关闭。
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
git clone https://github.com/advancedcat/langchain-rag.git
cd langchain-rag
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

默认索引 58 篇 LangChain / deepagents / LangGraph 文档（JS + Python），`md-header-v2` 切分后共 2858 chunks。**注意**：切分策略变更后必须 `--rebuild` 重建索引（`chunkerVersion` 热启动守卫会自动检测并提示）。

---

## 项目结构

Monorepo 使用 pnpm workspace 管理：

```
langchain-rag/
├── packages/
│   ├── rag/                        # 📦 核心 RAG Agent 包
│   │   ├── src/
│   │   │   ├── agent.ts            # 主入口：CLI + 流式事件渲染
│   │   │   ├── config.ts           # 环境变量解析与边界校验
│   │   │   ├── embeddings.ts       # 千问 Embedding 工厂
│   │   │   ├── vectorStore.ts      # Qdrant 向量存储（连接/索引/热启动守卫）
│   │   │   ├── chunking/           # 🧩 切分管道
│   │   │   │   ├── pipeline.ts     #   Loader → Detect → Split → Validate
│   │   │   │   ├── detect.ts       #   文档类型四层识别
│   │   │   │   ├── registry.ts     #   DocType → Splitter 注册表
│   │   │   │   ├── schema.ts       #   Chunk 契约（zod）
│   │   │   │   ├── splitters/      #   Markdown header / plaintext 切分器
│   │   │   │   └── compose.ts      #   消费侧 sectionPath 上下文组装
│   │   │   ├── ingestion/          # 📥 离线索引链路
│   │   │   │   └── index.ts        #   文档抓取 → 切分 → Embedding → 索引
│   │   │   └── retrieval/          # 🔍 在线召回链路
│   │   │       ├── index.ts        #   RAG Agent 构建
│   │   │       ├── pipeline.ts     #   检索管线编排（融合/截断）
│   │   │       ├── retrievers/     #   Dense / BM25 / Hybrid 检索器
│   │   │       ├── transformers/   #   Query Rewrite / Multi-Query
│   │   │       └── rerankers/      #   Cross-encoder Reranker 接口
│   │   ├── evals/                  # 🧪 离线评测
│   │   │   ├── retrieval/          #   检索评测
│   │   │   ├── generation/         #   生成评测（Faithfulness/Relevance）
│   │   │   ├── datasets/           #   Golden query 数据集
│   │   │   ├── baselines/          #   冻结的基准结果
│   │   │   └── results/            #   A/B 原始结果存档
│   │   ├── docs/                   # 设计文档（计划 + 回填结果）
│   │   ├── Milestone.md            # 里程碑记录（重要特性变更同步维护）
│   │   ├── Makefile                # 开发/评测命令入口
│   │   ├── docker-compose.yml      # 本地 Qdrant
│   │   └── .env.example
│   └── libs/                       # 📦 跨包共享工具
│       └── llm-provider.ts         #   统一 LLM 工厂
├── AGENTS.md                       # AI 编码代理指南
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
| `QDRANT_COLLECTION` | `langchain_docs_mdheader` | Qdrant collection 名称 |
| `RETRIEVAL_TOP_K` | `4` | 最终返回的 chunk 数 |
| `RETRIEVAL_FETCH_K` | `20` | 粗筛候选数 |
| `RETRIEVAL_ABSTENTION_THRESHOLD` | `0.78` | 拒答阈值（top dense cosine） |
| `RETRIEVAL_HYBRID_ENABLED` | `true` | 是否启用混合检索 |
| `RETRIEVAL_DENSE_WEIGHT` | `2` | Dense 检索融合权重 |
| `RETRIEVAL_SPARSE_WEIGHT` | `0.5` | BM25 检索融合权重 |
| `RETRIEVAL_QUERY_REWRITE` | `true` | 是否启用 Query Rewrite |
| `RETRIEVAL_RERANK_ENABLED` | `false` | 是否启用 Cross-encoder Rerank |
| `RETRIEVAL_MMR_ENABLED` | `false` | 是否启用 MMR（与 Rerank 互斥） |
| `INGESTION_MAX_HEADER_DEPTH` | `2` | Markdown header 切分深度（h1-h2） |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `200` | 超长 section 的二级字符切分参数 |

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

评测纪律：baseline 一经冻结不再修改；检索/切分策略变更必须与冻结基线 A/B 对比且主指标不退化（gate）才可设为生产默认；负结果同样记录原因。评测指标定义与全部基准对比详见 [evals/baselines/README.md](packages/rag/evals/baselines/README.md)。

---

## 技术栈

| 层 | 选型 |
|----|------|
| Agent 框架 | [deepagents](https://www.npmjs.com/package/deepagents) v1.x + LangChain 1.x |
| 编排运行时 | LangGraph（subagent streaming / StateBackend） |
| 向量存储 | [Qdrant](https://qdrant.tech/)（本地 Docker 部署，[选型报告](packages/rag/docs/vector-db-selection-report.md)） |
| Embedding | 千问 `qwen3.7-text-embedding`（DashScope OpenAI 兼容模式，1024 维） |
| Chat 模型 | DeepSeek `deepseek-v4-flash`（OpenAI 兼容 API） |
| Rerank | DashScope `qwen3-rerank`（Cross-encoder，可插拔，实验性） |
| 稀疏检索 | 纯内存 BM25（中文 unigram + 英文驼峰/连字符拆分） |
| 文档切分 | 插件化切分管道（TypeDetector + ChunkValidator）；自研 Markdown header 切分核 `md-header-v2`（h1-h2 + 超长 section 字符级二级切分） |
| 测试 | Vitest（171 用例，覆盖 chunking / BM25 / fusion / MMR / metrics） |
| 运行时 | Node.js + tsx（TypeScript native ESM） |
| 包管理 | pnpm workspace |

---

## 迭代历史

重要特性迭代以里程碑形式记录在 [packages/rag/Milestone.md](packages/rag/Milestone.md)：

| 日期 | 里程碑 | 结果 |
|------|--------|------|
| 08-12~13 | 项目奠基：模块化架构 + Qdrant + 基础 RAG 链路 | ✅ |
| 08-13 | 评测体系与 dense 冻结基线 | ✅ 基线冻结 |
| 08-14 | Phase 1：阈值过滤 + MMR | ⚠️ 未过 gate，默认关闭 |
| 08-16 | Phase 2：混合检索 + Query Rewrite | ✅ 生产默认 |
| 08-16 | Phase 3：Cross-encoder Rerank | ⚠️ 实验性，默认关闭 |
| 08-17 | 工程加固：参数化 + Vitest + 配置收敛 | ✅ |
| 08-18 | 切分管道：类型识别 + Splitter 插件化 + Chunk 契约 | ✅ md-header-v2 成为默认 |

各阶段设计文档（含计划与回填的评测结果）见 [packages/rag/docs/](packages/rag/docs/)。

---

## Roadmap

- [ ] **Metadata 路由** — 基于 `language` / `module` 元数据预过滤，解决跨语言与跨包混淆问题
- [ ] **Reranker 模型升级** — 接入 bge-reranker-v2-m3 或中文微调 reranker，替换当前效果未达预期的 qwen3-rerank
- [ ] **BM25 索引优化** — 流式增量构建 / 紧凑数据结构，支持 100k+ chunks 无 OOM；长期迁移至 Qdrant native sparse vectors
- [ ] **Phase 4 高级优化（按需）** — HyDE、Parent-Child chunking、上下文压缩
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

提交前请确保 `pnpm typecheck` 与 `pnpm test` 通过。**重要特性变更**（新检索策略、切分/索引契约变更、评测基线更新、架构级重构）需同步更新 [packages/rag/Milestone.md](packages/rag/Milestone.md)，详见 [AGENTS.md](./AGENTS.md)。

---

## License

本项目基于 [MIT License](./LICENSE) 开源。
