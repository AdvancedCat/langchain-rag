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
- [评测](#评测)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [配置说明](#配置说明)
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

## 评测

项目内置检索 + 生成两套离线评测体系，本节先给出当前基线结果，再说明复跑方式与指标口径。

### 评测结果

在 44 条 golden query（37 answerable + 7 unanswerable）上的检索评测（指标含义见 [指标说明](#指标说明)）：

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

### 运行评测

两套评测均通过 Makefile 触发：

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

### 指标说明

**相关性判定口径**：检索指标以 chunk 粒度判定——chunk 的 `docPath` 落在该查询的 `expectedDocPaths` 内即视为相关；除弃答指标外，聚合均值仅统计 37 条 answerable 查询。指标实现见 [evals/retrieval/metrics.ts](packages/rag/evals/retrieval/metrics.ts)。

**检索评测**（纯检索，不调 Chat LLM）：

| 指标 | 含义 | 衡量什么 |
|------|------|---------|
| Hit@K | 前 K 条结果中至少 1 条来自期望文档的查询占比 | 召回——"找得到"（↑ 越高越好） |
| Precision@K | 前 K 条结果中相关 chunk 的占比（相关数 / K） | top-K 信噪比——"返回的有多干净"（↑ 越高越好） |
| MRR | 首条相关结果排名倒数（1/rank，未命中记 0）的均值 | 排序——"第一条正确答案排多前"（↑ 越高越好） |
| NDCG@K | 位置折损的排序质量：相关结果越靠前贡献越大，除以理想排序做归一 | 排序——计入全部相关结果的位次（↑ 越高越好） |
| Keyword Recall | 期望关键词（`expectedKeywords`）在 top-K chunk 文本中的命中比例（词边界匹配） | 文本覆盖——补充 docPath 级判定的不足（↑ 越高越好） |
| Duplicate Chunk Ratio@K | top-K 中与前序结果同文档且 `chunkIndex` 相邻（±1）的 chunk 占比 | 上下文冗余（↓ 越低越好） |
| Unique Source Coverage@K | top-K 覆盖的不同文档数 / K | 来源多样性（↑ 越高越好） |
| Generation Context Quality@K | sourcePrecision 与 Keyword Recall 的调和平均 × 非重复率 | 这批上下文对生成价值的综合代理（↑ 越高越好） |

**弃答评测**（仅统计 7 条 unanswerable 查询）：

| 指标 | 含义 |
|------|------|
| Abstention Rate | top dense cosine score < 阈值（默认 0.78）的 unanswerable 查询占比，即正确拒答率（↑ 越高越好）。注意口径差异：**评测**基于 dense cosine；**在线生产**自 M8 起改用 cross-encoder rerank 分数闸门（默认阈值 0.52），dense 信号仅作 API 失败回退 |

**生成评测**（检索 → 生成 → LLM-as-judge）：

| 指标 | 含义 |
|------|------|
| Faithfulness | 将回答拆解为 ≤8 条原子事实声明，LLM 逐条判定是否被检索上下文直接支持，得分 = 支持数 / 声明数；拒答回答记满分 1.0。衡量幻觉（↑ 越高越好） |
| Relevance | LLM 从回答反向生成若干"该回答能解决的问题"，其 embedding 与原问题 embedding 的余弦相似度均值（RAGAS Answer Relevancy 风格）。衡量答非所问（↑ 越高越好） |

评测纪律：baseline 一经冻结不再修改；检索/切分策略变更必须与冻结基线 A/B 对比且主指标不退化（gate）才可设为生产默认；负结果同样记录原因。全部基准对比见 [evals/baselines/README.md](packages/rag/evals/baselines/README.md)。

---

## 快速开始

### 环境要求

- Node.js ≥ 18
- pnpm ≥ 10
- Docker（用于启动 Qdrant / Redis）
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

### 3. 启动基础设施（Qdrant + Redis）

```bash
# 在 packages/rag 目录下
make infra-up
# 或 docker compose up -d
```

Qdrant 监听 `http://localhost:6333`（向量库），Redis 监听 `localhost:6379`（API 服务的事件日志与 checkpoint，仅 `packages/api` 使用）。

### 4. 索引文档 + 启动问答

```bash
# 一键运行：索引文档 + 问答
pnpm run rag:index   # 仅索引文档
pnpm run rag         # 启动交互式问答
```

默认索引 58 篇 LangChain / deepagents / LangGraph 文档（JS + Python），`md-header-v2` 切分后共 2858 chunks。**注意**：切分策略变更后必须 `--rebuild` 重建索引（`chunkerVersion` 热启动守卫会自动检测并提示）。

> **语料来源与版权**：文档语料在运行时从 [docs.langchain.com](https://docs.langchain.com/) 按需抓取，版权归 LangChain 所有，本仓库不随包分发语料原文。`evals/baselines/` 评测结果文件中因复现需要嵌入了少量检索命中的文档片段（chunk），仅用于指标归因分析。

### 5.（可选）启动 API 服务

```bash
pnpm run serve        # packages/api，默认 http://localhost:3000
curl localhost:3000/ready   # agent 单例 + Redis 就绪探针
```

API 服务基于 Koa + AG-UI 协议向前端暴露流式问答事件（流式正文/Reasoning/工具调用/子代理进度），断线续传（Redis 事件日志持久化）随 M9-P2 落地。技术方案与实施进度见 [packages/rag/docs/api-service-plan.md](packages/rag/docs/api-service-plan.md)（M9，实施中——P0 基座 + P1 AG-UI 事件流已完成）。

```bash
# 触发一次问答（AG-UI v1.0 SSE binding）
curl -N -X POST localhost:3000/agui -H 'Content-Type: application/json' \
  -d '{"threadId":"t1","runId":"'"$(uuidgen)"'","messages":[{"id":"u0","role":"user","content":"什么是langchain"}]}'
```

---

## 项目结构

Monorepo 使用 pnpm workspace 管理：

```
langchain-rag/
├── packages/
│   ├── rag/                        # 📦 核心 RAG Agent 包（检索/切分/评测基座）
│   │   ├── src/
│   │   │   ├── index.ts            # 库入口（barrel）：createRagAgent 等，供 api 包导入
│   │   │   ├── agent.ts            # CLI 入口：交互问答 / --index-only 索引
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
│   │   │       ├── index.ts        #   RAG Agent 构建（可选 checkpointer）
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
│   │   ├── docker-compose.yml      # 本地基础设施：Qdrant + Redis
│   │   └── .env.example
│   ├── api/                        # 📦 API 服务包（@langchain-rag/api，M9 实施中）
│   │   ├── src/
│   │   │   ├── index.ts            # 服务入口：env 级联 → Koa 监听 → agent 预热
│   │   │   ├── app.ts              # 应用装配（CORS / 错误体 / 路由）
│   │   │   ├── config.ts           # 服务配置（PORT / REDIS_URL / 并发闸门…）
│   │   │   ├── env.ts              # .env 级联加载（自身 + rag）
│   │   │   ├── agentService.ts     # agent 进程内单例
│   │   │   ├── runManager.ts       # run 状态机：并发闸门/超时/取消/事件扇出
│   │   │   ├── agui/translator.ts  # deepagents v3 流 → AG-UI 事件（纯函数）
│   │   │   ├── sse.ts              # SSE 帧/心跳（断开≠取消）
│   │   │   ├── redis.ts            # Redis 客户端（懒连接）
│   │   │   └── routes/             # health/ready、POST /agui（AG-UI SSE）、cancel
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

完整配置见 [packages/rag/.env.example](packages/rag/.env.example) 和 [packages/rag/src/config.ts](packages/rag/src/config.ts)。API 服务另有 `PORT` / `REDIS_URL` / `RAG_MAX_CONCURRENT_RUNS` 等服务配置（见 [packages/api/.env.example](packages/api/.env.example)，检索/LLM 配置自动级联自 rag 的 `.env`）。

---

## 技术栈

| 层 | 选型 |
|----|------|
| Agent 框架 | [deepagents](https://www.npmjs.com/package/deepagents) v1.x + LangChain 1.x |
| 编排运行时 | LangGraph（subagent streaming / StateBackend） |
| API 服务 | Koa + [AG-UI 协议](https://docs.ag-ui.com)（流式事件 / 断线续传，M9 实施中） |
| 向量存储 | [Qdrant](https://qdrant.tech/)（本地 Docker 部署，[选型报告](packages/rag/docs/vector-db-selection-report.md)） |
| Embedding | 千问 `qwen3.7-text-embedding`（DashScope OpenAI 兼容模式，1024 维） |
| Chat 模型 | DeepSeek `deepseek-v4-flash`（OpenAI 兼容 API） |
| Rerank | DashScope `qwen3-rerank`（Cross-encoder，可插拔，实验性） |
| 稀疏检索 | 纯内存 BM25（中文 unigram + 英文驼峰/连字符拆分） |
| 文档切分 | 插件化切分管道（TypeDetector + ChunkValidator）；自研 Markdown header 切分核 `md-header-v2`（h1-h2 + 超长 section 字符级二级切分） |
| 测试 | Vitest（194 用例，覆盖 chunking / BM25 / fusion / MMR / metrics / API 配置、AG-UI 翻译与路由） |
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
| 09-22 | Rerank 弃答闸门（abstention 信号切换为 cross-encoder） | ✅ 误杀 19/37 → 0/37 |
| 10-10 | API 服务化：Koa + AG-UI + Redis 断线续传（M9） | 🚧 P0 基座完成，P1-P3 进行中 |

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
