# RAG 检索测评方案

> 本文档是 [retrieval-strategy-upgrade.md](./retrieval-strategy-upgrade.md) §8 的落地实现，定义了可复现的离线检索评测方法论、数据集结构、指标含义与使用方式。

---

## 1. 测评思路：离线检索评测

方案采用 **Retrieval-only 离线评测**，不做端到端 RAG 评测。

### 为什么不做端到端评测？

- **检索层是 RAG 的瓶颈**。垃圾进、垃圾出——检索不到相关文档，LLM 再强也答不对。
- **隔离变量**。端到端评测会混入 LLM 生成质量的波动，离线检索评测只评估「召回的文档对不对」，能精准定位是检索策略问题还是生成层问题。
- **快速迭代**。一次评测只需 embedding + 向量检索，不调用 Chat LLM，几十秒内跑完，适合频繁调参。

### 测评边界

| 评测对象 | 是否覆盖 | 说明 |
|---------|---------|------|
| 文档召回（Retrieval） | ✅ | 本方案核心 |
| 排序质量（Ranking） | ✅ | MRR / NDCG |
| 内容相关性（Context Precision） | ✅ | Keyword Recall 粗粒度验证 |
| 回答忠实度（Faithfulness） | ❌ | 需 LLM-as-judge，留待 Phase 4 |
| 回答完整性（Completeness） | ❌ | 需端到端评估，留待 Phase 4 |

---

## 2. 评测数据集

数据集文件：[`evals/datasets/langchain-rag.json`](../evals/datasets/langchain-rag.json)

### 2.1 语料库

当前语料库共 **58 篇文档**（见 [`src/config.ts`](../src/config.ts) 中的 `DOC_PATHS`），按模块分组：

| 分组 | 数量 | 作用 |
|------|------|------|
| LangChain JS 文档 | 14 | JS 核心检索目标 |
| deepagents JS 文档 | 13 | deepagents 检索目标 |
| LangGraph JS 文档 | 9 | LangGraph 检索目标 |
| LangChain Python 文档 | 8 | **跨语言噪声（hard negative）** |
| LangGraph Python 文档 | 6 | **跨语言噪声** |
| deepagents Python 文档 | 8 | **跨语言噪声** |

Python 文档与 JS 文档主题高度重叠（同名概念如 agents/tools/streaming），是刻意设计的 hard negative——如果检索策略把 Python 文档返回给问 JS 的 query，说明 embedding 的跨语言区分能力不足，这正是 BM25 + metadata 过滤要解决的问题。

### 2.2 Golden Queries

共 **35 条标注 query**，每条结构如下：

```typescript
interface GoldenQuery {
    id: string;              // 唯一标识，如 "q001"
    query: string;           // 中文自然语言问题
    type: QueryType;         // concept | api_usage | comparison | troubleshooting
    difficulty: Difficulty;  // easy | medium | hard
    expectedDocPaths: string[];  // 期望命中的文档路径（用于 Hit Rate/MRR/NDCG）
    expectedKeywords: string[];  // 期望包含的关键词（用于 Keyword Recall）
}
```

### 2.3 Query 类型覆盖

| 类型 | 数量 | 检索难点 | 主要验证策略 |
|------|------|---------|-------------|
| `concept` | 9 | 语义理解，表述多样 | Dense 检索 |
| `api_usage` | 13 | 精确符号匹配（`withStructuredOutput`、`addConditionalEdges` 等） | BM25 关键词检索 |
| `comparison` | 5 | 需同时命中多篇文档 | Multi-Query / 高 fetchK |
| `troubleshooting` | 6 | 错误信息、异常类名、排障 | Hybrid + Rerank |

每种类型对应不同的检索能力需求，确保每种策略都有它「该得分」的题目。

### 2.4 难度梯度

| 难度 | 数量 | 设计意图 |
|------|------|---------|
| `easy` | ~8 | Dense 检索即可命中，验证基础能力不退化 |
| `medium` | ~16 | 需要良好的语义匹配，当前策略可能部分失败 |
| `hard` | ~11 | 精确符号、跨文档、错误排查，是高级策略的主战场 |

难度梯度让你能看到策略改进「在哪个难度段生效」——只看 overall 指标可能掩盖 easy 段退化、hard 段提升的情况。

### 2.5 标注说明

- `expectedDocPaths` 允许多篇（comparison 类通常需要 2 篇以上），只要 top-k 中包含**至少一篇**即算命中。
- `expectedKeywords` 是粗粒度的内容验证，不依赖路径标注，即使 `docPath` 判断有偏差，关键词出现也说明检索到了正确的内容区域。
- 所有 query 均为中文，文档为英文（除 Python 噪声外），模拟真实跨语言检索场景。

---

## 3. 评估指标

指标实现在 [`evals/retrieval/metrics.ts`](../evals/retrieval/metrics.ts)。

### 3.1 Hit Rate@k

```
Hit Rate@k = (top-k 中至少有一篇相关文档的 query 数) / 总 query 数
```

- **衡量维度**：召回率——「有没有找到」
- **取值范围**：[0, 1]
- **计算位置**：同时计算 Hit@4（最终送入 LLM 的数量）、Hit@10、Hit@20（粗筛候选数）
- **目标值**：≥ 90%（Hit@4）

### 3.2 MRR（Mean Reciprocal Rank）

```
RR(query) = 1 / rank_of_first_relevant_doc   （未命中则为 0）
MRR = mean(RR over all queries)
```

- **衡量维度**：排序质量——「第一个对的排第几」
- **取值范围**：[0, 1]
- **与 Hit Rate 的区别**：Hit Rate 只看有没有，MRR 看排得好不好。正确文档排第 1 得 1.0，排第 4 得 0.25。
- **目标值**：≥ 0.7

### 3.3 NDCG@k（Normalized Discounted Cumulative Gain）

```
DCG@k = Σ_{i=1}^{k} (relevance_i / log2(i + 1))
NDCG@k = DCG@k / IDCG@k
```

其中 IDCG 是理想排序下的 DCG（所有相关文档排在最前面）。

- **衡量维度**：整体排序质量——「整个排序列表好不好」
- **取值范围**：[0, 1]，1.0 为完美排序
- **与 MRR 的区别**：MRR 只看第一个相关文档的位置，NDCG 考虑所有相关文档的位置和数量
- **特别适合**：comparison 类需要命中多篇文档的场景
- **目标值**：持续提升

### 3.4 Keyword Recall

```
Keyword Recall = (top-k 拼接文本中命中的 expectedKeywords 数) / expectedKeywords 总数
```

- **衡量维度**：内容粒度——「检索到的文本里有没有关键信息」
- **取值范围**：[0, 1]
- **作用**：不依赖文档路径标注的辅助指标，对 api_usage 类特别有效（检查代码标识符是否出现）
- **注意**：这是粗粒度指标，关键词出现不等于内容完整正确，仅作为补充信号

### 3.5 指标互补关系

| 指标 | 关心的问题 | 盲区 |
|------|-----------|------|
| Hit Rate@k | 有没有召回？ | 不关心排序 |
| MRR | 第一个对的排第几？ | 不关心第二篇及以后 |
| NDCG@k | 整体排序好不好？ | 对单篇命中的 query 与 MRR 重复 |
| Keyword Recall | 内容里有没有关键信息？ | 不关心文档来源是否正确 |

四个指标组合使用，才能完整刻画检索质量。

---

## 4. 报告结构

报告由 [`evals/retrieval/run.ts`](../evals/retrieval/run.ts) 生成，包含以下维度。

### 4.1 Overall 指标

```
Overall Metrics:
  Hit Rate@4   : 82.9%
  Hit Rate@10  : 94.3%
  MRR          : 0.682
  NDCG@10      : 0.715
  Keyword Recall: 75.2%
```

### 4.2 按 Query Type 分组

```
By Query Type:
  Type              Count  Hit@4   Hit@10  MRR     NDCG@10
  concept               9   100%    100%    0.92    0.89
  api_usage            13    69%     92%    0.55    0.61
  comparison            5    80%    100%    0.72    0.68
  troubleshooting       6    67%     83%    0.48    0.52
```

归因方法：
- `api_usage` 的 Hit@4 低但 Hit@10 高 → BM25 能召回但排序不好，需要 Rerank
- `troubleshooting` 的 Hit@10 就低 → 召回阶段就漏了，需要 Query 改写或 Multi-Query
- `concept` 已接近满分 → Dense 检索足够，不需要额外策略

### 4.3 按 Difficulty 分组

```
By Difficulty:
  Difficulty        Count  Hit@4   Hit@10  MRR     NDCG@10
  easy                  8   100%    100%    0.95    0.93
  medium               16    81%     94%    0.65    0.68
  hard                 11    64%     82%    0.45    0.49
```

如果 hard 段提升但 easy 段下降，说明策略过拟合了难题，需要调整参数（如降低 `lambda`、调高阈值）。

### 4.4 失败 Query 列表

报告末尾列出 Hit@4=0 的 query，对比期望文档与实际命中文档：

```
Failed Queries (Hit@4 = 0):
  [q029] (troubleshooting/hard)
    Q: deepagents 子代理执行超时或达到 recursion limit 怎么解决？
    Expected: subagents, graph-api
    Got: overview, quickstart, backends, streaming
```

这是最直接的 bad case 分析入口，用于判断是「召不回」还是「排不对」。

---

## 5. 使用方式

### 5.1 命令行参数

```bash
# 首次运行（重建索引，因为语料可能已扩充）
pnpm run eval:rebuild

# 后续评估（复用已有索引）
pnpm run eval

# 输出 JSON（用于 A/B 对比）
pnpm run eval:json > eval-results/baseline.json

# 只跑某类 query
pnpm run eval -- --type api_usage
pnpm run eval -- --difficulty hard

# 调整粗筛候选数
pnpm run eval -- --k 30

# 指定数据集文件
pnpm run eval -- --dataset ./evals/datasets/my-dataset.json
```

### 5.2 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--rebuild` | false | 强制重建向量索引（语料变更后使用） |
| `--k` | 20 | 粗筛候选数（rerank 前的 fetchK） |
| `--top-k` | 4 | 最终返回数（Hit Rate 计算的主 k 值） |
| `--type` | 全部 | 过滤 query 类型：concept/api_usage/comparison/troubleshooting |
| `--difficulty` | 全部 | 过滤难度：easy/medium/hard |
| `--dataset` | 默认数据集 | 指定 golden dataset 路径 |
| `--json` | false | 以 JSON 格式输出完整报告 |

### 5.3 A/B 对比工作流

每次实施检索策略变更时：

```bash
# 1. 变更前：保存 baseline
git checkout main
pnpm run eval:rebuild
pnpm run eval:json > eval-results/baseline.json

# 2. 变更后：保存新结果
git checkout feature/phase1-threshold
pnpm run eval -- --rebuild
pnpm run eval:json > eval-results/phase1.json

# 3. 对比关键指标
# 重点关注：
#    - Hit Rate@4 是否提升（不能退化）
#    - MRR 是否提升
#    - easy 段是否退化
#    - 失败 query 列表是否减少
```

---

## 6. 与分阶段实施的配合

| Phase | 评测方式 | 验证的假设 |
|-------|---------|-----------|
| **Phase 1**（阈值 + MMR） | baseline vs threshold+MMR，对比 Hit@4 和 Keyword Recall | 阈值过滤能否去掉 Python 噪声？MMR 能否减少冗余？ |
| **Phase 2**（BM25 + Query Rewrite） | 重点对比 `api_usage` 类的 Hit@4 和 MRR | BM25 对精确符号的召回是否显著提升？Query Rewrite 是否提升了 hard 段？ |
| **Phase 3**（Rerank） | 对比 Hit@20→rerank→Hit@4 的 MRR/NDCG | Cross-encoder 能否把正确文档从 top-20 提到 top-4？ |
| **Phase 4** | 引入 LLM-as-judge 评估 Answer Faithfulness | 端到端回答质量是否提升？ |

### Phase 1 的预期基线

首次运行 `pnpm run eval:rebuild` 后，baseline 策略（纯 dense，k=4）预计表现：

- easy 段 Hit@4 接近 100%
- medium 段 Hit@4 约 70-85%
- hard 段 Hit@4 约 50-70%
- 部分 query 会错误命中 Python 文档（跨语言噪声）
- `api_usage` 类的精确符号匹配可能表现不佳

这个 baseline 是后续所有改进的对照基准。

---

## 7. 扩展评测集

随着实施推进，应持续补充 golden queries：

1. **从真实失败中收集**：每次发现 bad case，将其标注后加入数据集。
2. **保持类型平衡**：新增 query 时注意四种类型的比例，不要让某一类过多。
3. **难度标注要诚实**：如果 dense 一次就命中，标 easy；需要 hybrid 才命中，标 medium/hard。
4. **expectedDocPaths 可以有多篇**：comparison 类问题通常需要 2 篇以上。
5. **expectedKeywords 选 discriminating terms**：选能区分正确/错误文档的关键词，而不是「agent」「tool」这种高频通用词。

---

## 附录：文件索引

| 文件 | 职责 |
|------|------|
| [`evals/shared/types.ts`](../evals/shared/types.ts) | 跨层级共享类型定义（GoldenQuery、RetrievedChunk 等） |
| [`evals/retrieval/types.ts`](../evals/retrieval/types.ts) | 检索评测专属类型（EvalReport、EvalConfig 等） |
| [`evals/retrieval/metrics.ts`](../evals/retrieval/metrics.ts) | 指标计算（Hit Rate/MRR/NDCG/Keyword Recall） |
| [`evals/retrieval/run.ts`](../evals/retrieval/run.ts) | 检索评测主运行器：加载索引 → 逐条检索 → 聚合报告 |
| [`evals/generation/run.ts`](../evals/generation/run.ts) | 生成评测主运行器：retrieve → generate → faithfulness/relevance |
| [`evals/datasets/langchain-rag.json`](../evals/datasets/langchain-rag.json) | Golden queries 数据集 |
