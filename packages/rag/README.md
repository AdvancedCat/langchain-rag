# Docs RAG Agent

基于 LangChain Deep Agents 的文档问答 Agent，实现 **Retrieve → Offload → Delegate** 三步 RAG 工作流。

## 架构概览

```
用户提问
  │
  ▼
search_documentation (向量检索)
  │  top-4 chunks
  ▼
StateBackend (Offload 到 /retrieved/ 文件系统)
  │  避免上下文膨胀
  ▼
chunk-analyst × N (并行子 Agent 分析)
  │  每个子 Agent 独立上下文
  ▼
主 Agent 综合回答（含来源引用）
```

## 技术栈

| 组件 | 选型 |
|-----|------|
| Agent 框架 | `deepagents` v1.x |
| 向量存储 | `QdrantVectorStore`（Qdrant，本地 Docker 部署） |
| 文档拆分 | `RecursiveCharacterTextSplitter` (chunk 1000, overlap 200) |
| Embedding | 千问 `qwen3.7-text-embedding`（DashScope OpenAI 兼容模式） |
| Chat 模型 | 通过 `libs/llm-provider` 统一提供（DeepSeek） |

## 快速开始

### 1. 环境准备

```bash
cp .env.example .env
# 编辑 .env，填入你的 API Key
```

必须配置：

- `DASHSCOPE_API_KEY` — 千问 DashScope Embedding API Key
- `DEEPSEEK_API_KEY` — DeepSeek Chat 模型 API Key

可选配置：

- `QDRANT_URL` — Qdrant 地址，默认 `http://localhost:6333`
- `QDRANT_COLLECTION` — 集合名称，默认 `langchain_docs`

### 2. 启动向量数据库 Qdrant

RAG 系统依赖 Qdrant 向量库，需要先启动：

```bash
# 使用 Make（推荐）
make infra-up

# 或直接使用 Docker Compose
docker compose up -d
```

Qdrant 会监听在 `http://localhost:6333`。停止：`make infra-down`。

### 3. 安装依赖

```bash
pnpm install
```

### 4. 运行

```bash
# 一键运行：索引文档 + 问答
pnpm run start

# 仅索引文档（不执行问答）
pnpm run index

# 强制重建索引
pnpm run start -- --rebuild

# 类型检查
pnpm run typecheck
```

## Embedding 配置

使用千问 DashScope Embedding，通过环境变量配置：

- `DASHSCOPE_API_KEY`（必填）— API Key，[千问 AI 平台](https://platform.qianwenai.com/home/api-keys)获取
- `DASHSCOPE_BASE_URL`（可选）— API 端点，默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `QWEN_EMBEDDING_MODEL`（可选）— 模型名称，默认 `qwen3.7-text-embedding`
- `QWEN_EMBEDDING_DIMENSIONS`（可选）— 自定义向量维度，支持范围 256~2560

## 索引文档

默认索引 **58 篇** LangChain OSS 文档（路径见 `src/config.ts` 中 `DOC_PATHS`），覆盖 LangChain / deepagents / LangGraph 三大模块的 JS 与 Python 文档，主题包括 Agents、RAG、Tools、Models、Middleware、Subagents、Streaming、MCP、Human-in-the-loop 等。

> 其中 Python 文档与 JS 文档主题高度重叠，被刻意保留作为「跨语言 hard negative」噪声，用于评测检索策略的区分能力。

扩展索引只需在 `DOC_PATHS` 中追加新路径。

## 项目结构

按 **知识入库链路** 和 **在线召回链路** 拆分模块化架构：

```
rag/
├── src/
│   ├── agent.ts              # 主入口：CLI 参数解析 + 流式事件渲染
│   ├── config.ts             # 共享配置常量、类型定义
│   ├── embeddings.ts         # 千问 Embedding 工厂
│   ├── vectorStore.ts        # Qdrant 向量存储（连接/校验/索引/重建）
│   ├── ingestion/            # 📥 知识入库链路（Offline Indexing）
│   │   └── index.ts          #   文档抓取 → 文本切分 → Embedding → 索引
│   └── retrieval/            # 🔍 在线召回链路（Online Serving）
│       └── index.ts          #   RAG Agent 构建：检索工具 + chunk-analyst 子代理
├── evals/                    # 🧪 离线评测（检索 + 生成）
│   ├── shared/               #   共享类型（GoldenQuery、RetrievedChunk）
│   ├── retrieval/            #   检索评测（Hit@k / MRR / NDCG / Keyword Recall）
│   ├── generation/           #   生成评测（Faithfulness + Relevance）
│   ├── datasets/             #   Golden queries 数据集
│   └── baselines/            #   基线报告存档
├── docs/                     # 设计文档（检索策略升级、评测方案）
├── Makefile                  # 开发 / 评测命令入口
├── docker-compose.yml        # 本地 Qdrant
├── package.json
├── tsconfig.json
├── .env.example              # 环境变量模板
└── .gitignore
```

### 模块职责

| 模块 | 职责 | 关键导出 |
|-----|------|---------|
| `config.ts` | 常量与类型 | `DOC_PATHS`, `EXAMPLE_QUERY`, `DOCS_BASE` |
| `embeddings.ts` | 千问 Embedding 工厂 | `getEmbeddingConfig()`, `createEmbeddings()` |
| `vectorStore.ts` | Qdrant 向量存储 | `ensureQdrantRunning()`, `loadVectorStore()`, `createVectorStoreFromDocuments()` |
| `ingestion/` | 离线索引 Pipeline | `buildVectorStore()` |
| `retrieval/` | 在线 Agent 服务 | `createRagAgent()` |

## 评测

项目内置两套离线评测，通过 `pnpm run eval*` 或 `make eval*` 触发（详见 `docs/evaluation-plan.md`）：

```bash
# 检索评测（纯检索，不调 Chat LLM）
pnpm run eval              # 文本报告
pnpm run eval:json         # JSON 输出
pnpm run eval:rebuild      # 强制重建索引后评测

# 生成评测（检索 → 生成 → faithfulness + relevance）
pnpm run eval:gen
pnpm run eval:gen:json
```

常用 `make` 目标：`make help` 查看全部，`make eval` / `make eval-gen` 支持通过变量覆盖参数（如 `make eval K=30 TOP_K=8`）。
