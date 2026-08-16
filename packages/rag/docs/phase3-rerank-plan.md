# Phase 3 实施计划：Cross-encoder Rerank 精排

> **Phase 标记**：`Phase 3（Rerank）`
> **所属**：`packages/rag` 检索策略升级
> **上游文档**：[retrieval-strategy-upgrade.md](./retrieval-strategy-upgrade.md) §7 Phase 3、[evaluation-plan.md](./evaluation-plan.md) §6
> **状态**：待实施
> **性质**：在 Phase 2 召回已饱和的基础上，用 Cross-encoder 精排提升 top-k 排序质量
> **模型**：DashScope `qwen3-rerank`（文本重排，100+ 语种）

---

## 1. 现状与动机

### 1.1 Phase 2 后的检索链路

当前在线检索位于 [pipeline.ts](../src/retrieval/pipeline.ts)，流程为：

```
User Query
    │
    ▼
Query Rewrite (DeepSeek, LRU 缓存, fallback 原 query)
    │
    ├─► Dense Vector Retrieval (qwen3.7-text-embedding, Qdrant HNSW, denseTopK=30)
    │
    ├─► BM25 Sparse Retrieval (in-memory JS, unigram 分词, sparseTopK=5)
    │
    ▼
Score-level Boost Fusion (dense 权重 2.0, sparse 权重 0.5, Min-Max 归一化)
    │
    ▼
slice(0, topK=4) → 写入 /retrieved/ → chunk-analyst 子 Agent
```

- Query 改写、混合检索、BM25 boost 已在 Phase 2 实施完成。
- MMR 和 scoreThreshold 存在于 config 中但默认关闭（Phase 1 标定未通过 gate）。
- **无 Rerank 精排**：融合后的排序直接作为最终顺序。

### 1.2 冻结基线（hybrid-rewrite，dataset v2，2026-08-16）

来源：[hybrid-rewrite-20260816.json](../evals/baselines/retrieval/hybrid-rewrite-20260816.json)

| 指标 | 值 |
|------|-----|
| 数据集 | v2，44 query（37 answerable + 7 unanswerable），58 页 / ~2681 chunks |
| Hit@4 / Prec@4 / MRR | **91.9% / 41.2% / 0.684** |
| Hit@10 / Hit@20 | **100% / 100%** |
| NDCG@4 / NDCG@10 / NDCG@20 | 0.436 / 0.393 / 0.363 |
| Keyword Recall | 58.6% |
| Duplicate Ratio@4 | 8.8% |
| Unique Source Coverage@4 | 74.3% |
| Context Quality@4 | 38.2% |
| Abstention Rate | **100%（7/7）** |

### 1.3 核心诊断：召回已饱和，瓶颈在排序

数据揭示了一个明确的信号：

| 观察 | 数据 | 含义 |
|------|------|------|
| Hit@20 = 100% | 所有 answerable 在 top-20 内 | 粗筛召回**零遗漏** |
| Hit@10 = 100% | 所有 answerable 在 top-10 内 | 召回深度充足 |
| Hit@4 = 91.9% | 3 条 answerable 在 top-4 之外 | 正确文档已在候选池，但**排不进前 4** |
| MRR = 0.684 | 首个相关文档平均排名 ~1.46 | top-4 内部排序有提升空间 |
| Precision@4 = 41.2% | top-4 平均仅 1.6 条相关 | 噪声 chunk 占据 context slot |
| NDCG@4 = 0.436 | — | 整体排序质量低 |

**结论：Phase 2 已解决召回问题（Recall），Phase 3 要解决的是排序问题（Ranking）。** 这正是 Cross-encoder Rerank 的经典适用场景——Bi-encoder（embedding）负责高效粗筛，Cross-encoder 负责精细排序。

### 1.4 痛点分布

按 query 类型：

| 类型 | 数量 | Hit@4 | MRR | 诊断 |
|------|------|-------|-----|------|
| concept | 10 | 100% | 0.725 | 已接近满分，不可退化 |
| api_usage | 16 | 93.8% | 0.797 | 1 条失败，排序较好 |
| comparison | 6 | 100% | **0.458** | 能命中但多篇排序混乱，rerank 可改善 |
| troubleshooting | 5 | **60%** | **0.509** | 2/5 在 top-10 内但排不进 top-4，**rerank 主战场** |

按难度：

| 难度 | 数量 | Hit@4 | MRR | 诊断 |
|------|------|-------|-----|------|
| easy | 9 | 100% | 0.685 | guardrail，不可退化 |
| medium | 20 | 75% | 0.638 | 5 条失败，Hit@10 仅 80%（部分召回问题，rerank 收益有限） |
| hard | 15 | **66.7%** | **0.425** | 5 条失败，排序差，rerank 预期收益最大 |

---

## 2. Rerank 模型选型

### 2.1 选型：qwen3-rerank

| 项目 | 值 |
|------|-----|
| 模型名 | `qwen3-rerank` |
| 供应商 | 阿里云百炼 / DashScope |
| 模型页 | https://www.qianwenai.com/models/qwen3-rerank |
| 类型 | 文本 Cross-encoder rerank |
| 语种 | 100+ 语种（含中文、英文） |
| 最大文档数/请求 | 500 |
| 单文档 max tokens | 4,000 |
| 请求 max input tokens | 30,000 |
| 价格 | ¥0.5 / M tokens |
| RPM / TPM | 5,000 / 5B |
| API Key | `DASHSCOPE_API_KEY`（已配置于 `.env`，与 embedding 共用） |

**选型理由：**
1. 与现有 embedding 模型 `qwen3.7-text-embedding` 同代，模型对齐更好。
2. 原生支持中文 query + 英文文档的跨语言 rerank。
3. API Key 已存在，无需新增密钥或依赖。
4. 单次请求约 16K tokens（20 docs × ~800 tokens），成本约 ¥0.008，可忽略。
5. 最大文档数 500，远大于 fetchK=20~30，无批量截断风险。

### 2.2 与 gte-rerank 的关系

设计文档 [retrieval-strategy-upgrade.md](./retrieval-strategy-upgrade.md) 原始建议为 `gte-rerank`，但该模型已于 2026-05-30 下线。`qwen3-rerank` 是官方推荐的替代模型，能力更强、语种支持更广。

### 2.3 不选 qwen3-vl-rerank 的原因

`qwen3-vl-rerank` 是多模态模型（支持图片/视频），对纯文本场景无额外收益，且最大文档数仅 100、价格更高（¥0.7/M vs ¥0.5/M）。本项目语料全部为文本文档，`qwen3-rerank` 是更精准的选择。

---

## 3. API 技术规格

### 3.1 端点

```
POST https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
```

> ⚠️ 此端点与 embedding 使用的 `DASHSCOPE_BASE_URL`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）**不同**，不可复用。需新增独立的 `DASHSCOPE_RERANK_URL` 环境变量。

### 3.2 请求头

```
Authorization: Bearer ${DASHSCOPE_API_KEY}
Content-Type: application/json
```

### 3.3 请求体（DashScope 原生嵌套结构）

```json
{
  "model": "qwen3-rerank",
  "input": {
    "query": "如何从子代理流式传输中间工具结果？",
    "documents": [
      "chunk text 1...",
      "chunk text 2..."
    ]
  },
  "parameters": {
    "top_n": 4,
    "return_documents": false
  }
}
```

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `model` | string | ✅ | 固定 `qwen3-rerank` |
| `input.query` | string | ✅ | 查询文本，max 4,000 tokens |
| `input.documents` | string[] | ✅ | 候选文档列表，max 500 条 |
| `parameters.top_n` | int | ❌ | 返回前 N 条，默认返回全部 |
| `parameters.return_documents` | bool | ❌ | 是否回传原文，默认 `false`（我们已有原文，设为 false 节省带宽） |

### 3.4 响应体

```json
{
  "output": {
    "results": [
      { "index": 12, "relevance_score": 0.9532 },
      { "index": 3,  "relevance_score": 0.8741 },
      { "index": 27, "relevance_score": 0.6120 },
      { "index": 0,  "relevance_score": 0.4205 }
    ]
  },
  "usage": { "total_tokens": 3421 },
  "request_id": "..."
}
```

| 字段 | 说明 |
|------|------|
| `output.results[].index` | 对应输入 `documents` 数组的原始下标 |
| `output.results[].relevance_score` | 相关性分数，范围 [0, 1]，按降序排列 |
| `usage.total_tokens` | 本次请求消耗的 token 数 |

> **重要**：`relevance_score` 仅在**同一请求内**有相对排序意义，**不可跨请求比较**或设全局阈值。Abstention 判断继续使用 dense cosine score，不依赖此分数。

### 3.5 错误响应

失败时 HTTP 非 2xx，响应体包含：

```json
{
  "code": "InvalidApiKey",
  "message": "Invalid API key provided.",
  "request_id": "..."
}
```

客户端需检查 HTTP 状态码和响应体中的 `code` 字段。

---

## 4. 架构设计

### 4.1 两阶段检索架构

```
全库 ~2681 chunks
    │
    │  Stage 1: Bi-encoder 粗筛（快，已有）
    │  Dense (qwen3.7-embedding) + BM25 Boost Fusion
    │
    ▼
top-fetchK candidates（默认 20 条，按融合分排序）
    │
    │  Stage 2: Cross-encoder 精排（慢但准，新增）
    │  qwen3-rerank 对 query + 每条 doc 做 token 级交互打分
    │
    ▼
top-topN chunks（默认 4 条，按 relevance_score 排序）
    │
    ▼
写入 /retrieved/ → chunk-analyst
```

### 4.2 Rerank 在管线中的位置

修改后的 [pipeline.ts](../src/retrieval/pipeline.ts) `retrieve()` 流程：

```
Query
  │
  ├─ transformQueries() → rewrite / multiQuery
  │
  ├─ retrieveDense(denseTopK=30) × N queries
  │     └─ deduplicateMerge() → candidates
  │
  ├─ BM25 retrieve(sparseTopK=5) × N queries
  │     └─ applyBM25Boost() → fusedCandidates
  │
  ├─ ★ fusedCandidates.slice(0, config.fetchK)     ← 粗筛截断（fetchK=20）
  │
  ├─ ★ if rerank.enabled:
  │     reranker.rank(queries[0], docs, topN)
  │       → rerankedCandidates（score = relevance_score）
  │     fallback: fusedCandidates.slice(0, topN)
  │
  ├─ scoreThreshold filter（non-hybrid 时，rerank 后通常不启用）
  │
  └─ if mmr.enabled: MMR select（rerank 启用时 config 校验禁止同时开启）
      else: return
```

### 4.3 Query 选择

Multi-query 时产生多个改写 query。Rerank 使用 `queries[0]`（即 rewrite 后的主 query），因为：
- Rerank 是对融合后的统一候选池做精排，不需要多角度。
- 主 query 已经过 rewrite 优化，表述最清晰。
- 多次 rerank 调用会增加延迟和成本，无显著收益。

### 4.4 Score 语义设计

| 字段 | rerank 前 | rerank 后 | 用途 |
|------|----------|----------|------|
| `denseScore` | dense cosine | **不变** | Abstention 阈值判断（0.78） |
| `score` | BM25 boost 融合分 | `relevance_score` | 排序 + chunk 头部分数展示 |
| `rerankScore` | — | 新增，等于 `relevance_score` | 调试 / 观测 |
| `retrievalSource` | `'dense'` / `'hybrid'` | 保持 `'hybrid'` | 标识召回来源 |

**关键约束：`denseScore` 字段在 rerank 后保持原值不变。** 这确保了 [index.ts:52](../src/retrieval/index.ts#L52) 中 `getMaxDenseScore(allCandidates)` 的 abstention 判断不受 rerank 分数替换的影响。

> 注意：rerank 后候选数 = topN（4 条），`getMaxDenseScore` 在这 4 条中取最大值。若正确文档因 rerank 未进 top-4 但 denseScore 很高——理论上不应发生（cross-encoder 精度高于 bi-encoder），但需 eval 验证。

### 4.5 MMR 与 Rerank 的互斥

MMR 和 Rerank 不应同时启用：
- **Rerank**：纯相关性优化，精度优先。
- **MMR**：牺牲相关性换取多样性。

在 config 校验中增加约束：`rerank.enabled=true` 时强制 `mmr.enabled=false`（启动时报错或 warning）。两者目标不同，同时启用会互相干扰。

### 4.6 Fallback 机制

Rerank API 调用失败时（网络错误、超时、5xx、限流），管线优雅降级：

```
try {
    results = await reranker.rank(query, documents, topN)
} catch (error) {
    console.warn('[Rerank] API failed, falling back to fusion order:', error.message)
    results = fusedCandidates.slice(0, topN)  // 按 BM25 boost 融合分排序
}
```

- 超时设 10 秒（`AbortController`）。
- Fallback 时输出 warn 日志，不阻断检索流程。
- Fallback 到 Phase 2 融合排序，保证可用性。

---

## 5. 代码改动清单

### 5.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/retrieval/rerankers/index.ts` | `Reranker` 接口定义 + `RerankResult` 类型 + 工厂函数 |
| `src/retrieval/rerankers/dashscope.ts` | DashScope qwen3-rerank HTTP 客户端实现 |

### 5.2 修改文件

| 文件 | 改动内容 |
|------|---------|
| [src/config.ts](../src/config.ts) | `RetrievalConfig` 新增 `rerank` 段；`getRetrievalConfig()` 新增 env 解析 + 校验 |
| [src/retrieval/pipeline.ts](../src/retrieval/pipeline.ts) | `RetrieveDeps` 新增 `reranker?`；融合后插入 fetchK 截断 + rerank 调用 + fallback |
| [src/retrieval/types.ts](../src/retrieval/types.ts) | `ScoredChunk` 新增 `rerankScore?` 字段；`RetrievalSourceType` 无需新增（rerank 不改变来源标识） |
| [src/retrieval/index.ts](../src/retrieval/index.ts) | `createRagAgent` 中根据 config 构造 reranker 实例并注入 deps |
| [evals/retrieval/types.ts](../evals/retrieval/types.ts) | `RetrievalStrategy` 联合类型新增 `'hybrid-rerank'` |
| [evals/retrieval/run.ts](../evals/retrieval/run.ts) | `buildRetrievalConfig` 新增 `hybrid-rerank` 分支；构造 reranker 传入 deps |
| [.env](../.env) | 新增 rerank 相关环境变量（默认关闭） |

### 5.3 接口定义

```typescript
// src/retrieval/rerankers/index.ts

export interface RerankResult {
    index: number;           // 输入 documents 数组的原始下标
    relevanceScore: number;  // [0, 1]，同一请求内相对有效
}

export interface Reranker {
    rank(query: string, documents: string[], topN: number): Promise<RerankResult[]>;
}
```

```typescript
// src/retrieval/rerankers/dashscope.ts
// 使用原生 fetch，无新依赖
// POST to DASHSCOPE_RERANK_URL
// body: { model, input: { query, documents }, parameters: { top_n, return_documents: false } }
// parse: response.output.results → RerankResult[]
// AbortController timeout 10s
// HTTP non-2xx or response.code → throw Error
```

### 5.4 配置扩展

`RetrievalConfig` 新增：

```typescript
rerank: {
    enabled: boolean;       // 默认 false
    model: string;          // 默认 'qwen3-rerank'
    topN: number;           // 默认等于 topK（4）
    rerankUrl: string;      // DashScope native endpoint
}
```

环境变量：

```bash
# Rerank
RETRIEVAL_RERANK_ENABLED=false
RETRIEVAL_RERANK_MODEL=qwen3-rerank
RETRIEVAL_RERANK_TOP_N=4
DASHSCOPE_RERANK_URL=https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
```

Config 校验规则：
- `rerank.enabled=true` 时 `rerank.topN <= fetchK`
- `rerank.enabled=true` 时 `mmr.enabled` 必须为 false
- `rerank.topN > 0`
- `DASHSCOPE_API_KEY` 必须存在（复用 embedding 的 key 校验）

---

## 6. 评估方案

### 6.1 新增 eval strategy

在 `RetrievalStrategy` 联合类型中新增 `'hybrid-rerank'`：

| Strategy | Hybrid | Rewrite | BM25 | Rerank | 用途 |
|----------|--------|---------|------|--------|------|
| `hybrid-rewrite` | ✅ | ✅ | ✅ | ❌ | Baseline（当前生产默认） |
| `hybrid-rerank` | ✅ | ✅ | ✅ | ✅ | **Phase 3 实验策略** |

`hybrid-rerank` 配置：
- `hybrid.enabled = true`
- `queryTransform.rewrite = true`
- `rerank.enabled = true`
- `rerank.topN = 4`
- `fetchK = 20`
- `mmr.enabled = false`

### 6.2 A/B 对比命令

```bash
cd packages/rag

# 1. Baseline（当前生产策略，复用已有索引）
pnpm run eval -- --strategy hybrid-rewrite --json > evals/baselines/retrieval/hybrid-rewrite-20260816.json

# 2. + Rerank（复用同一索引，仅新增 rerank API 调用）
pnpm run eval -- --strategy hybrid-rerank --json > evals/baselines/retrieval/hybrid-rerank-20260816.json

# 3. 按类型/难度细分
pnpm run eval -- --strategy hybrid-rerank --type troubleshooting
pnpm run eval -- --strategy hybrid-rerank --difficulty hard
```

### 6.3 评估指标

无需新增 metric，复用现有指标体系。重点关注：

**Primary（必须显著提升）：**

| 指标 | Baseline | Phase 3 目标 | 理由 |
|------|----------|-------------|------|
| Hit@4 | 91.9% | **≥ 95%** | 消除 3 个 answerable 失败中的 2+ 个 |
| MRR | 0.684 | **≥ 0.80** | 正确文档排名前移 |
| NDCG@4 | 0.436 | **显著提升** | top-4 内部排序改善 |

**Secondary（期望提升）：**

| 指标 | Baseline | Phase 3 目标 |
|------|----------|-------------|
| Precision@4 | 41.2% | ≥ 55% |
| troubleshooting Hit@4 | 60% | ≥ 80% |
| hard MRR | 0.425 | ≥ 0.65 |
| Keyword Recall | 58.6% | 提升或持平 |
| Context Quality@4 | 38.2% | 提升 |

**Guardrail（不可退化）：**

| 指标 | Baseline | 约束 |
|------|----------|------|
| easy Hit@4 | 100% | **必须保持 100%** |
| concept Hit@4 | 100% | **必须保持 100%** |
| Abstention Rate | 100%（7/7） | **必须保持 100%** |
| Hit@20 | 100% | 不可退化（rerank 只重排不丢文档） |

### 6.4 失败分析

报告末尾的失败 query 列表是关键诊断入口。Rerank 后需对比：
- 哪些 baseline 失败 query 被修复（预期：troubleshooting/hard 类）
- 是否有新的退化 query（预期：无，但需验证 easy 段）
- Rerank 是否把 Python 噪声文档排到了 JS 文档前面（cross-encoder 的跨语言区分能力验证）

### 6.5 Ablation 实验（可选）

若 primary 指标提升不明显，可追加以下消融：

| 实验 | 配置 | 验证假设 |
|------|------|---------|
| Rerank only（无 rewrite） | hybrid-bm25 + rerank | Rewrite 是否干扰 rerank 的精确匹配 |
| 不同 fetchK | fetchK=10 / 20 / 30 | 粗筛池大小对 rerank 效果的影响 |
| Rerank topN=6 | 返回 6 条而非 4 条 | 更大的 context window 是否带来 generation 收益 |

---

## 7. 风险与缓解

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| **Rerank 拉低 easy 段** | Cross-encoder 对简单 query 可能过度"思考"，把明显相关的文档排后 | Guardrail 检查 easy Hit@4=100%；不通过则不启用 |
| **Abstention 退化** | rerank 后 top-4 的 denseScore 分布变化，可能影响 `getMaxDenseScore` | 保持 `denseScore` 字段不变；eval 验证 abstention=100% |
| **API 延迟** | 单次 rerank 预计 200-800ms，增加端到端延迟 | 10s 超时；仅对 20 条做 rerank（非全库）；可观测日志记录耗时 |
| **API 失败 / 限流** | 网络抖动或 DashScope 服务不可用 | Fallback 到融合排序；warn 日志不阻断 |
| **跨语言 rerank 质量** | 中文 query + 英文文档，cross-encoder 可能不如单语准确 | qwen3-rerank 原生支持 100+ 语种；eval 验证 |
| **relevance_score 不可跨请求比较** | 分数分布因 query 而异，不能设全局阈值 | 不依赖 rerank score 做 abstention 或 threshold，继续用 denseScore |
| **额外 API 成本** | 每次检索新增一次 rerank 调用 | 单次约 ¥0.008；Query Rewrite 已有 LRU 缓存，rerank 可考虑后续加缓存 |
| **MMR 与 Rerank 冲突** | 两者目标不同（多样性 vs 精度） | config 校验强制互斥 |

---

## 8. 实施步骤（每步一个 gate）

1. **配置层**：[config.ts](../src/config.ts) 新增 `rerank` 段 + env 解析 + 校验规则 → `pnpm run typecheck`
2. **Reranker 实现**：新建 `rerankers/dashscope.ts` + `rerankers/index.ts`，纯 HTTP 客户端，含超时和错误处理 → `pnpm run typecheck`
3. **类型扩展**：[types.ts](../src/retrieval/types.ts) 的 `ScoredChunk` 新增 `rerankScore?` → `pnpm run typecheck`
4. **管线改造**：[pipeline.ts](../src/retrieval/pipeline.ts) 插入 fetchK 截断 + rerank + fallback 逻辑 → `pnpm run typecheck`
5. **线上接入**：[index.ts](../src/retrieval/index.ts) 构造 reranker 实例注入 deps → `pnpm run typecheck`
6. **Eval 接入**：[evals/retrieval/types.ts](../evals/retrieval/types.ts) + [run.ts](../evals/retrieval/run.ts) 新增 `hybrid-rerank` strategy → `pnpm run typecheck`
7. **环境变量**：[.env](../.env) 新增 rerank 配置段（默认 `ENABLED=false`）
8. **Baseline 复现**：`pnpm run eval -- --strategy hybrid-rewrite` 确认与冻结 baseline 一致
9. **Rerank A/B**：`pnpm run eval -- --strategy hybrid-rerank` 跑评估，对比指标
10. **复盘与归档**：按 type/difficulty/bad case 分析；保存 `hybrid-rerank-YYYYMMDD.json`；更新 baselines README 和本文件的结果章节

---

## 9. 预期收益与诚实评估

### 9.1 预期收益

Rerank 的核心价值是**把正确的文档排到更前的位置**：

- Hit@4 从 91.9% 提升到 95%+：top-10 内的 3 条失败 query，cross-encoder 应能识别其真实相关性并提升排名。
- MRR 从 0.684 提升到 0.80+：即使文档已在 top-4 内，rerank 也能把最相关的排到第 1 位。
- Precision@4 从 41.2% 提升到 55%+：cross-encoder 能识别 bi-encoder 误判为"相关"的噪声文档并降级。
- troubleshooting 和 hard 段预期收益最大。

### 9.2 诚实边界

- **Rerank 不能解决召回问题**。medium 段 Hit@10 仅 80%，说明有 4 条 query 的正确文档在 top-10 之外，rerank 无法凭空召回。这需要 Phase 4 的 Multi-Query 或 metadata 过滤解决。
- **Rerank 对 easy/concept 段几乎无收益**（已 100%），需严格确保不退化。
- **Rerank 不能解决 BM25 中文分词精度问题**，但 cross-encoder 对中文的理解能力远强于 unigram BM25。
- **q001 的 Python 文档噪声问题**：rerank 可能通过跨语言语义理解改善 JS vs Python 的区分，但这不是保证——若 rerank 仍将 Python 文档排前，需要 metadata `language` 过滤（Phase 4）。

### 9.3 成功 / 失败判定

| 结果 | 判定 | 后续动作 |
|------|------|---------|
| Primary 全部达标 + Guardrail 不退化 | ✅ 成功 | 默认启用 rerank，归档结果 |
| Primary 部分达标 + Guardrail 不退化 | ⚠️ 部分成功 | 分析 bad case，考虑 ablation 或调参 |
| Guardrail 退化（easy < 100% 或 abstention < 100%） | ❌ 失败 | 保持 rerank 默认关闭，记录失败原因，排查模型行为 |

---

## 附录 A：DashScope Rerank HTTP 调用参考

### cURL 示例

```bash
curl --location 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank' \
--header "Authorization: Bearer $DASHSCOPE_API_KEY" \
--header 'Content-Type: application/json' \
--data '{
  "model": "qwen3-rerank",
  "input": {
    "query": "什么是文本排序模型",
    "documents": [
      "文本排序模型广泛用于搜索引擎和推荐系统中，它们根据文本相关性对候选文本进行排序",
      "量子计算是计算科学的一个前沿领域",
      "预训练语言模型的发展给文本排序模型带来了新的进展"
    ]
  },
  "parameters": {
    "top_n": 2,
    "return_documents": false
  }
}'
```

### TypeScript fetch 示例（无新依赖）

```typescript
const response = await fetch(rerankUrl, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        model: 'qwen3-rerank',
        input: { query, documents },
        parameters: { top_n: topN, return_documents: false },
    }),
    signal: AbortSignal.timeout(10_000),
});

if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Rerank API ${response.status}: ${err.message ?? response.statusText}`);
}

const data = await response.json();
const results: RerankResult[] = data.output.results.map((r: {
    index: number;
    relevance_score: number;
}) => ({
    index: r.index,
    relevanceScore: r.relevance_score,
}));
```

---

## 附录 B：术语表

| 术语 | 说明 |
|------|------|
| **Bi-encoder** | 双塔模型，query 和 doc 分别编码为向量，用于高效粗筛（即当前 embedding 模型） |
| **Cross-encoder** | 单塔模型，query+doc 拼接后一起编码，捕捉 token 级交互，精度高但速度慢，用于精排 |
| **Rerank** | 对粗筛候选集做更精细的相关性排序 |
| **fetchK** | 粗筛候选数（rerank 前），默认 20 |
| **topN / topK** | rerank 后保留数量 / 最终送入 LLM 的 chunk 数，默认 4 |
| **relevance_score** | Cross-encoder 输出的相关性分数 [0,1]，仅同请求内相对有效 |
