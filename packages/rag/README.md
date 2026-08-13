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
| Embedding | OpenAI `text-embedding-3-small` / 千问 `qwen3.7-text-embedding` |
| Chat 模型 | `gpt-4o-mini` |

## 快速开始

### 1. 环境准备

```bash
cp .env.example .env
# 编辑 .env，填入你的 API Key
```

至少需要配置以下之一：

- `OPENAI_API_KEY` — OpenAI（embedding + chat 模型）
- `DASHSCOPE_API_KEY` — 千问 DashScope（替代 OpenAI embedding，chat 仍用 OpenAI）

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

# 类型检查
pnpm run typecheck
```

## Embedding 模型切换

代码通过环境变量自动切换 embedding provider，无需改动代码：

| 场景 | 配置方式 |
|-----|---------|
| 使用 OpenAI | `.env` 仅设 `OPENAI_API_KEY`，不设 `DASHSCOPE_API_KEY` |
| 使用千问 | `.env` 设 `DASHSCOPE_API_KEY`，可选设 `QWEN_EMBEDDING_DIMENSIONS`（256~2560） |

千问 API Key 获取：[千问 AI 平台](https://platform.qianwenai.com/home/api-keys)

## 索引文档

默认索引 14 篇 LangChain OSS 文档（路径见 `agent.ts` 中 `DOC_PATHS`），覆盖 Agents、RAG、Tools、Models、Middleware、Subagents、Streaming、LangGraph 等主题。

扩展索引只需在 `DOC_PATHS` 中追加新路径。

## 项目结构

```
rag/
├── agent.ts          # 主入口：文档加载、向量索引、Agent 创建、问答执行
├── package.json
├── tsconfig.json
├── .env.example      # 环境变量模板
└── .gitignore
```