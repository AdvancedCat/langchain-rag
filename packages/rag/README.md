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
| 向量存储 | `MemoryVectorStore` |
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

### 2. 安装依赖

```bash
pnpm install
```

### 3. 运行

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

默认索引 14 篇 LangChain OSS 文档（路径见 `src/config.ts` 中 `DOC_PATHS`），覆盖 Agents、RAG、Tools、Models、Middleware、Subagents、Streaming、LangGraph 等主题。

扩展索引只需在 `DOC_PATHS` 中追加新路径。

## 项目结构

按 **知识入库链路** 和 **在线召回链路** 拆分模块化架构：

```
rag/
├── src/
│   ├── agent.ts              # 主入口：CLI 参数解析 + 流式事件渲染
│   ├── config.ts             # 共享配置常量、类型定义
│   ├── embeddings.ts         # 千问 Embedding 工厂
│   ├── vectorStore.ts        # 向量存储持久化（save/load + 版本校验）
│   ├── ingestion/            # 📥 知识入库链路（Offline Indexing）
│   │   └── index.ts          #   文档加载 → 文本切分 → Embedding → 索引 → 持久化
│   └── retrieval/            # 🔍 在线召回链路（Online Serving）
│       └── index.ts          #   RAG Agent 构建：检索工具 + chunk-analyst 子代理
├── package.json
├── tsconfig.json
├── .env.example              # 环境变量模板
└── .gitignore
```

### 模块职责

| 模块 | 职责 | 关键导出 |
|-----|------|---------|
| `config.ts` | 常量与类型 | `DOC_PATHS`, `VECTOR_STORE_PATH`, `EXAMPLE_QUERY` |
| `embeddings.ts` | 千问 Embedding 工厂 | `getEmbeddingConfig()`, `createEmbeddings()` |
| `vectorStore.ts` | 向量存储 IO | `saveVectorStore()`, `loadVectorStore()` |
| `ingestion/` | 离线索引 Pipeline | `buildVectorStore()` |
| `retrieval/` | 在线 Agent 服务 | `createRagAgent()` |
