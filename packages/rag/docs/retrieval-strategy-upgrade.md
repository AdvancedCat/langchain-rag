# RAG 检索策略升级设计

> 本文档面向 `packages/rag` 项目，规划从「单一 top-k 向量相似度检索」向「多层级、可组合的高级检索管线」演进的方案。

---

## 1. 现状分析

### 1.1 当前检索链路

当前在线召回链路位于 `src/retrieval/index.ts`，核心检索逻辑仅有一行：

```typescript
const retrievedDocs = await vectorStore.similaritySearch(query, 4);
```

完整链路：

```
User Query
    │
    ▼
vectorStore.similaritySearch(query, k=4)   ← 唯一检索环节
    │
    ▼
top-4 chunks（无过滤、无重排、无去重）
    │
    ▼
写入 StateBackend /retrieved/ → chunk-analyst 子 Agent 分析
```

### 1.2 存在的问题

| # | 问题 | 影响 |
|---|------|------|
| P1 | **纯向量检索**，无法命中关键词精确匹配场景（如 API 名称、错误码、配置项） | 召回率不足 |
| P2 | **top-k 固定为 4**，没有相似度阈值 | query 与文档无关时仍硬凑 4 条，注入噪声 |
| P3 | **无去重 / 多样性控制**，相邻 chunk 内容高度重叠 | 冗余信息浪费子 Agent context |
| P4 | **无 Query 理解与改写**，用户原始 query 可能口语化、模糊、含指代 | embedding 质量不稳定 |
| P5 | **无 Rerank 精排**，向量近似排序不等于语义相关性排序 | top-4 精度上限低 |
| P6 | **检索参数硬编码**（k=4、chunkSize=1000、overlap=200），无法针对不同 query 类型调优 | 迭代困难 |

---

## 2. 升级目标

1. **提升召回率**：不遗漏语义相关但表述不同的内容。
2. **提升精确率**：送入 LLM 的每一个 chunk 都尽可能相关。
3. **降低噪声**：无关 chunk 不进入上下文，减少幻觉与 token 浪费。
4. **可配置、可观测**：每一层检索策略可独立开关，关键指标可度量。
5. **向后兼容**：默认行为保持可用，高级策略通过配置渐进式启用。

---

## 3. 分层检索架构设计

整体采用业界成熟的 **Retrieval Pipeline** 模式，将检索拆为五个独立可插拔的层级：

```
                         ┌─────────────────────────────────┐
                         │        Layer 0: Query 理解       │
                         │  (Rewrite / HyDE / Multi-Query) │
                         └───────────────┬─────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
            │  Vector Search│   │   BM25 / KW  │    │  Metadata    │
            │  (Semantic)   │   │  (Lexical)   │    │  Filtering   │
            └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
                   │   Layer 1: 召回    │                    │
                   └────────────────────┼────────────────────┘
                                        ▼
                         ┌─────────────────────────────────┐
                         │  Layer 2: Fusion (RRF / Weighted)│
                         └───────────────┬─────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────┐
                         │  Layer 3: Post-Filter            │
                         │  (threshold / dedup / MMR)       │
                         └───────────────┬─────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────┐
                         │  Layer 4: Rerank (Cross-encoder) │
                         └───────────────┬─────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────┐
                         │  Layer 5: Context Compression   │
                         │  (extract relevant spans)       │
                         └─────────────────────────────────┘
```

每一层都设计为**可选中间件**，通过配置组合启用。

---

## 4. 各层策略详解

### Layer 0：Query 理解与改写

> 目标：把用户的「原始问题」转化为更适合检索的「一个或多个查询」。

#### 4.1 Query Rewriting（查询改写）

让 LLM 将口语化、含指代的 query 改写为清晰、自包含的检索 query。

- **适用场景**：多轮对话中的 follow-up 问题（"那第二种方式呢？"）。
- **实现要点**：传入对话历史，输出独立可检索的 query。
- **成本**：一次额外的轻量 LLM 调用（可用小模型）。

#### 4.2 HyDE（Hypothetical Document Embeddings）

让 LLM 先生成一段「假设性答案」，再用这段假设答案的 embedding 去检索，而非用原始 query。

- **原理**：假设答案在向量空间中更接近真实文档，比短 query 的 embedding 质量更高。
- **适用场景**：query 很短、信息量不足时效果显著。
- **风险**：LLM 生成的假设答案可能含错误信息，可能带偏检索；建议只取其 embedding，不将文本送入最终 context。

#### 4.3 Multi-Query Retrieval

让 LLM 从不同角度生成 N 个（通常 3–5 个）改写 query，分别检索后合并去重。

- **原理**：单次 query 的 embedding 有随机性，多角度检索提升召回覆盖。
- **实现**：对每个 query 独立检索，合并结果后通过 RRF 融合排序。
- **成本**：N 倍检索调用量，但 embedding 可并行。

#### 选型建议

| 策略 | 推荐启用场景 | 默认配置 |
|------|-------------|---------|
| Query Rewriting | 有多轮对话时 | 启用（需 checkpointer 支持） |
| HyDE | 短 query、FAQ 场景 | 可选，A/B 验证 |
| Multi-Query | 对召回率要求高、文档量大 | 可选，N=3 |

---

### Layer 1：多路召回

> 目标：同时利用「语义相似」和「关键词精确匹配」两种信号。

#### 4.4 Dense Vector Retrieval（已有）

使用 embedding 模型做余弦相似度检索，当前已实现。

- 保留 `MemoryVectorStore` / `QdrantVectorStore` 双后端。
- Qdrant 原生支持 HNSW 索引和高效 ANN 检索。

#### 4.5 Sparse / BM25 Retrieval（新增）

基于词频的稀疏检索，擅长精确匹配专有名词、代码符号、错误信息。

- **实现方案**：
  - 轻量：使用 `memory` 后端时，引入 `okapibm25` 或自建 TF-IDF；
  - 生产：Qdrant 原生支持 sparse vectors，可与 dense vector 共存于同一 collection。
- **与 dense 检索互补**：
  - Dense：理解语义，"如何流式输出" ≈ "streaming intermediate results"。
  - Sparse：精确命中，`streamEvents`、`baseOffset`、`RecursiveCharacterTextSplitter` 等标识符。

#### 4.6 Metadata Filtering（元数据过滤）

利用 chunk 的 metadata 做预过滤，缩小检索范围。

当前 chunk 已有的 metadata：
- `source`、`docPath`、`docType`
- `chunkIndex`、`totalChunks`、`indexedAt`、`fetchedAt`

可扩展：
- `docSection`（通过 MarkdownHeaderTextSplitter 提取的标题层级）；
- `tags` / `category`（文档分类）；
- `language`（中英文文档区分）。

**示例**：用户问 "deepagents 的子代理"，可预过滤 `docPath` 包含 `deepagents` 的文档。

---

### Layer 2：结果融合

> 目标：将多路召回的结果合并为一个统一排序的列表。

#### 4.7 RRF（Reciprocal Rank Fusion）

业界最常用的无参数融合方法：

```
score(d) = Σ  1 / (k + rank_i(d))
```

- `k` 通常取 60；
- 不需要各路分数归一化，对 dense + sparse 分数尺度差异天然鲁棒；
- LangChain 提供 `EnsembleRetriever` 内置 RRF 实现。

#### 4.8 加权线性融合

如果能标定各路分数到同一尺度（如都归一化到 [0,1]），可按权重加权：

```
final_score = α · dense_score + (1-α) · sparse_score
```

- α 可调（默认 0.5）；
- 适合有评估集做网格搜索的场景。

---

### Layer 3：后过滤与多样性

> 目标：在精排之前，先去掉明显不相关和冗余的结果。

#### 4.9 相似度阈值过滤

设置 `scoreThreshold`，低于阈值的 chunk 直接丢弃。

- 解决 P2 问题：query 与文档无关时返回空结果，而非硬凑。
- 阈值需根据 embedding 模型的分数分布标定（千问 embedding 的 cosine 分布需实测）。
- Agent 侧需处理"检索结果为空"的情况：提示用户或改写 query 重试。

#### 4.10 MMR（Maximal Marginal Relevance）

在「相关性」和「多样性」之间做权衡：

```
MMR = argmax [ λ · sim(q, d) - (1-λ) · max sim(d, d_selected) ]
```

- `lambda` 接近 1：纯相关性排序（当前行为）；
- `lambda` 接近 0：最大化多样性，避免重复内容；
- 推荐 `lambda = 0.7` 起步。
- LangChain 的 `VectorStore` 已内置 `maxMarginalRelevanceSearch` 方法，Memory/Qdrant 后端均支持。

#### 4.11 相邻 Chunk 去重 / 合并

同一文档的相邻 chunk 因 `chunkOverlap=200` 存在内容重叠：

- 检测到连续 chunk 同时命中时，可合并为一个更大的上下文窗口；
- 或在 metadata 中标记 `prevChunkId` / `nextChunkId`，检索时自动扩展上下文（Parent-Child Chunk 模式）。

---

### Layer 4：Rerank 精排

> 目标：用更强的模型对召回的 top-N（如 20 条）做精细相关性打分，取 top-k（如 4 条）送入 LLM。

#### 4.12 Cross-encoder Reranker

**为什么需要 rerank？**

- Bi-encoder（embedding 模型）将 query 和 doc 分别编码为向量，速度快但丢失了细粒度交互信息；
- Cross-encoder 将 query + doc 拼接后一起输入 Transformer，能捕捉 token 级别的交互关系，精度显著更高，但速度慢，不适合全库检索。

**典型两阶段架构**：

```
全库 10000 chunks
    │  Bi-encoder 粗筛（快）
    ▼
top-20 candidates
    │  Cross-encoder 精排（慢但准）
    ▼
top-4 final chunks → LLM
```

**模型选型**：

| 模型 | 语言 | 部署方式 | 备注 |
|------|------|---------|------|
| `bge-reranker-v2-m3` | 多语言（含中文） | 本地 Transformers / FastAPI | 开源首选 |
| `bge-reranker-large` | 中英 | 本地 | 经典稳定 |
| Cohere Rerank API | 多语言 | 云端 API | 免运维，按量付费 |
| 千问 / DashScope Rerank | 中文优 | 云端 API | 与 embedding 同供应商，集成简单 |

**与本项目的集成点**：

- 封装一个 `Reranker` 接口（`rank(query, docs) → ScoredDocument[]`）；
- 支持本地模型（通过 `@xenova/transformers`）和云端 API 两种实现；
- 在 `search_documentation` tool 内部、融合过滤之后调用。

---

### Layer 5：上下文压缩（可选）

> 目标：即使 chunk 被检索到，其中也可能只有几句话与 query 相关。压缩可以去掉无关部分，节省 token。

#### 4.13 LLM-based Context Compression

使用 `ContextualCompressionRetriever` + LLM compressor，提取每个 chunk 中与 query 相关的句子。

- 成本：每个 chunk 一次 LLM 调用；
- 适合 chunk 较大（>1000 chars）或 token 预算紧张时。

#### 4.14 Embedding-based Extraction

更轻量的方案：将 chunk 再按句子拆分，对每个句子算 embedding，只保留与 query 相似度高于阈值的句子。无需额外 LLM 调用。

---

## 5. 配置设计

所有检索参数统一在 `src/config.ts` 中定义，并支持环境变量覆盖。

### 5.1 配置接口

```typescript
export interface RetrievalConfig {
    // 召回
    topK: number;                    // 最终返回给 Agent 的 chunk 数，默认 4
    fetchK: number;                  // 粗筛候选数（rerank 前），默认 20
    scoreThreshold?: number;         // 相似度阈值，默认 undefined（不过滤）

    // 多路召回
    hybrid: {
        enabled: boolean;            // 是否启用 BM25 + vector 混合检索
        denseWeight: number;         // dense 权重 α，默认 0.5
        sparseWeight: number;        // sparse 权重，默认 0.5
    };

    // Query 改写
    queryTransform: {
        rewrite: boolean;            // 查询改写
        hyde: boolean;               // HyDE
        multiQuery: boolean;         // Multi-Query
        multiQueryCount: number;     // 改写 query 数量，默认 3
    };

    // 多样性
    mmr: {
        enabled: boolean;
        lambda: number;              // 相关性-多样性权衡，默认 0.7
    };

    // Rerank
    rerank: {
        enabled: boolean;
        provider: 'cohere' | 'dashscope' | 'local';
        model: string;
        topN: number;                // rerank 后保留数量
    };

    // 上下文压缩
    compression: {
        enabled: boolean;
        mode: 'llm' | 'embedding';
    };
}
```

### 5.2 环境变量映射

```bash
# 检索参数
RETRIEVAL_TOP_K=4
RETRIEVAL_FETCH_K=20
RETRIEVAL_SCORE_THRESHOLD=0.7

# 混合检索
RETRIEVAL_HYBRID_ENABLED=true
RETRIEVAL_DENSE_WEIGHT=0.6
RETRIEVAL_SPARSE_WEIGHT=0.4

# Query 改写
RETRIEVAL_QUERY_REWRITE=true
RETRIEVAL_HYDE=false
RETRIEVAL_MULTI_QUERY=false
RETRIEVAL_MULTI_QUERY_COUNT=3

# MMR
RETRIEVAL_MMR_ENABLED=true
RETRIEVAL_MMR_LAMBDA=0.7

# Rerank
RETRIEVAL_RERANK_ENABLED=false
RETRIEVAL_RERANK_PROVIDER=dashscope
RETRIEVAL_RERANK_MODEL=gte-rerank
RETRIEVAL_RERANK_TOP_N=4

# 上下文压缩
RETRIEVAL_COMPRESSION_ENABLED=false
```

---

## 6. 代码结构规划

在现有 `retrieval/` 目录下扩展：

```
src/retrieval/
├── index.ts                  # createRagAgent 入口（保持不变）
├── searchTool.ts             # search_documentation tool 定义
├── retrievers/
│   ├── index.ts              # Retriever 工厂：根据 config 组装 pipeline
│   ├── vector.ts             # Dense vector retriever
│   ├── bm25.ts               # Sparse BM25 retriever
│   ├── hybrid.ts             # EnsembleRetriever (RRF fusion)
│   └── mmr.ts                # MMR 包装器
├── transformers/
│   ├── index.ts
│   ├── queryRewrite.ts       # Query 改写
│   ├── hyde.ts               # HyDE
│   └── multiQuery.ts         # Multi-Query
├── rerankers/
│   ├── index.ts              # Reranker 接口与工厂
│   ├── cohere.ts
│   ├── dashscope.ts
│   └── local.ts
└── compression/
    ├── index.ts
    ├── llmCompressor.ts
    └── embeddingCompressor.ts
```

### 关键接口抽象

```typescript
// 统一的 Retriever 接口（复用 LangChain BaseRetriever）
interface RetrievalPipeline {
    retrieve(query: string, options?: RetrieveOptions): Promise<ScoredDocument[]>;
}

interface ScoredDocument extends Document {
    score: number;
    retrievalSource: 'dense' | 'sparse' | 'hybrid';
}

interface Reranker {
    rank(query: string, docs: Document[]): Promise<ScoredDocument[]>;
}

interface QueryTransformer {
    transform(query: string, context?: Message[]): Promise<string | string[]>;
}
```

---

## 7. 分阶段实施计划

### Phase 1：低成本高收益（已实施，候选策略未通过 gate）

不引入新依赖，快速解决最痛的问题。

1. [x] **相似度阈值过滤**：共享 pipeline 使用带分数返回的 `similaritySearchVectorWithScore`，过滤低分结果。
2. [x] **MMR 去冗余**：使用 `@langchain/core/utils/math` 的 `maximalMarginalRelevance`，保留原始 score。
3. [x] **topK / fetchK 可配置化**：硬编码参数已移入 config 与 `RETRIEVAL_*` env。
4. [x] **空结果处理**：tool 明确提示 Agent 改写 query 后重试。
5. [ ] **默认启用 threshold + MMR**：2026-08-14 网格中无参数满足不退化约束，保持 `scoreThreshold` 未设置、`mmr.enabled=false`。

标定摘要：0.50/0.55 + lambda=0.7 的 Hit@4/Precision@4/MRR 为 83.8%/36.5%/0.577，低于 frozen baseline 的 89.2%/41.2%/0.652；easy Hit@4 也由 88.9% 降到 77.8%。虽然 Keyword Recall 从 57.7% 升到 65.8%，且 top-4 平均唯一文档数由 2.82 升到 3.02，但不足以通过 gate。详见 [Phase 1 实施计划与结果](./phase1-threshold-mmr-plan.md#5-实施与标定结果2026-08-14)。

### Phase 2：混合检索 + Query 改写（3–5 天）

1. 引入 BM25 sparse retriever（Memory 后端先用纯 JS 实现）。
2. 用 `EnsembleRetriever` 组装 dense + sparse，RRF 融合。
3. 实现 Query Rewriting（利用已有 DeepSeek LLM）。
4. 可选：Multi-Query 并行检索。

### Phase 3：Rerank 精排（2–3 天）

1. 定义 `Reranker` 接口，先接入 DashScope Rerank API（与现有 embedding 同供应商）。
2. 调整 fetchK=20 → rerank → topK=4。
3. 建立评估集，对比开启 rerank 前后的命中率。

### Phase 4：高级优化（按需）

1. HyDE 及 A/B 测试。
2. Parent-Child chunking（小块检索、大块返回上下文）。
3. MarkdownHeaderTextSplitter 改造 chunk 策略，增加 section metadata。
4. 上下文压缩。
5. Qdrant sparse vector 生产级部署。

---

## 8. 评估方案

检索质量的提升必须可度量，不能凭感觉。

### 8.1 构建评估集

从以下来源收集 30–50 个测试 query：

- `EXAMPLE_QUERY` 及开发过程中的真实提问；
- LangChain 文档 FAQ / GitHub Issues 高频问题；
- 覆盖不同类型：概念解释、API 用法、错误排查、对比选型。

每个 query 标注：
- 期望命中的文档路径（`docPath`）；
- 可选：期望包含的关键代码片段 / 术语。

### 8.2 评估指标

| 指标 | 含义 | 目标 |
|------|------|------|
| **Hit Rate @k** | top-k 中包含至少一个相关文档的 query 比例 | ≥ 90% |
| **MRR** (Mean Reciprocal Rank) | 第一个相关文档排名的倒数均值 | ≥ 0.7 |
| **NDCG @k** | 考虑相关性等级的排序质量 | 持续提升 |
| **Context Precision** | 送入 LLM 的 chunk 中相关 chunk 占比 | ≥ 0.8 |
| **Answer Faithfulness** | 最终回答是否可从检索内容中推导（用 LLM-as-judge） | ≥ 0.9 |

### 8.3 评估工具

- LangSmith 提供原生的 RAG 评估数据集和 evaluator；
- 或用 `ragas`（TS 移植版）做离线批量评估；
- 每次调整检索参数后跑一遍评估集，对比指标变化。

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| **延迟增加** | 多层检索 + rerank 会增加单次查询耗时 | 各层并行化；rerank 用小模型/API；设置总超时 |
| **成本上升** | Query 改写和 rerank 引入额外 LLM/API 调用 | 用小模型做改写；缓存高频 query 的改写结果；只对 top-N 做 rerank |
| **过度工程** | 文档量仅 14 篇时，复杂管线收益有限 | 按 Phase 渐进启用；小文档库停在 Phase 1 即可 |
| **阈值难标定** | scoreThreshold 依赖 embedding 模型分布 | 启动时打印分数分布日志；用评估集标定 |
| **BM25 中文分词** | 中文无空格分隔，需分词器 | 引入 `nodejieba` 或按字符 n-gram；Qdrant sparse 可用内置分词 |
| **Reranker 与 Embedding 不匹配** | 不同模型对相关性判断可能不一致 | 用评估集验证；优先选择同系列模型 |

---

## 10. 与现有系统的集成点

| 现有模块 | 改造内容 |
|---------|---------|
| `src/retrieval/index.ts` | `similaritySearch(query, 4)` 替换为 `retrievalPipeline.retrieve(query)` |
| `src/vectorStore.ts` | 新增 `similaritySearchWithScore` 方法；Qdrant 侧支持 sparse vector |
| `src/config.ts` | 新增 `RetrievalConfig` 及环境变量解析 |
| `src/ingestion/index.ts` | chunking 阶段增加 section metadata；为 BM25 构建词频索引 |
| `libs/llm-provider.ts` | 可能需要新增轻量模型实例用于 query 改写（低成本模型） |
| `StateBackend` | 不变，retrieved chunk 仍写入 `/retrieved/` 供子 Agent 读取 |

---

## 附录 A：术语表

| 术语 | 说明 |
|------|------|
| **Bi-encoder** | 双塔模型，query 和 doc 分别编码为向量，用于高效粗筛 |
| **Cross-encoder** | 单塔模型，query+doc 拼接编码，精度高但速度慢，用于精排 |
| **HyDE** | Hypothetical Document Embeddings，用 LLM 生成假设答案再检索 |
| **MMR** | Maximal Marginal Relevance，相关性与多样性权衡的选样算法 |
| **RRF** | Reciprocal Rank Fusion，基于排名倒数的多路结果融合算法 |
| **Rerank** | 对粗筛候选集做更精细的相关性排序 |
| **Hit Rate@k** | top-k 结果中包含相关文档的查询比例 |
| **MRR** | Mean Reciprocal Rank，首个相关文档排名倒数的均值 |
| **NDCG** | Normalized Discounted Cumulative Gain，带位置折扣的排序质量指标 |
