# Phase 1 实施计划：相似度阈值过滤 + MMR 去冗余

> **Phase 标记**：`Phase 1（阈值 + MMR）`
> **所属**：`packages/rag` 检索策略升级
> **上游文档**：[retrieval-strategy-upgrade.md](./retrieval-strategy-upgrade.md) §7 Phase 1、[evaluation-plan.md](./evaluation-plan.md) §6
> **状态**：方案已定（决策已收敛），待实施（未改代码）
> **性质**：低成本高收益，不引入新依赖

---

## 1. 现状

### 1.1 当前链路

在线召回位于 `src/retrieval/index.ts`，核心只有一行：

```typescript
const retrievedDocs = await vectorStore.similaritySearch(query, 4);
```

链路为：`query → similaritySearch(k=4) → 写入 /retrieved/ → chunk-analyst 分析`。
**无过滤、无去重、无重排，k 硬编码为 4。**

### 1.2 要解决的两个问题

| # | 问题 | 影响 |
|---|------|------|
| P2 | top-k 固定为 4，无相似度阈值 | query 与文档无关时仍硬凑 4 条，注入噪声 |
| P3 | 无去重 / 多样性控制，相邻 chunk 高度重叠 | 冗余浪费子 Agent context |

> 注：跨语言噪声（Python 页压过 JS 页，如 q001）**不属于 Phase 1 范畴**，需 Phase 2/3 的 BM25+metadata / Rerank 解决。

### 1.3 冻结基线（dense，dataset v2，2026-08-13）

来源：`evals/baselines/retrieval/baseline-dense-20260813.json`、`evals/baselines/README.md`

| 指标 | 值 |
|------|-----|
| 数据集 | v2，44 query（37 answerable + 7 unanswerable），58 页 / 2681 chunks |
| Hit@4 / Prec@4 / MRR | **89.2% / 41.2% / 0.652** |
| NDCG@4 / NDCG@10 | 0.426 / 0.380 |
| 按难度 Hit@4 | easy 88.9% / medium 75.0% / hard 66.7% |
| answerable topScore | avg 0.769（min 0.629，max 0.866） |
| unanswerable topScore | avg 0.693（min 0.583，max 0.789） |

**关键结论（已记录）**：0.78 阈值会误杀 19/37 answerable → raw cosine 分数**不能**可靠区分 answerable/unanswerable。这决定阈值只做噪声过滤、不做拒答（见 2.1-D1）。

---

## 2. 动作

### 2.1 设计决策

- **D1 — 阈值只做噪声过滤，不做拒答**：`scoreThreshold` 不预设单一值，用 `{0.50, 0.55, 0.60, 0.65}` 网格实测，由 Hit@4/Precision@4 数据选定默认值；不沿用 0.78（已记录会误杀 19/37 answerable）。空结果由「过滤后为空」触发，而非绝对分数。
- **D2 — MMR 用 `@langchain/core/utils/math` 的 `maximalMarginalRelevance`**：不用 `vectorStore.maxMarginalRelevanceSearch`（不返回分数、无法与阈值组合）。前者返回选中索引，可在 `similaritySearchVectorWithScore` 候选上做、保留 score。`lambda=0.7`。
- **D3 — 管线顺序**：`embedQuery → similaritySearchVectorWithScore(fetchK=20) → 阈值过滤 → MMR 选 topK=4 → 返回带 score`。
- **D4 — 配置化**：新增 `RetrievalConfig`（`topK=4, fetchK=20, scoreThreshold?, mmr.enabled=false, mmr.lambda=0.7`）+ `RETRIEVAL_*` env 映射 + `.env.example`。
- **D5 — 评测可切换**：eval 加 `--strategy baseline-dense|threshold-mmr`、`--score-threshold`、`--mmr-lambda`；`EvalConfig.retrievalStrategy` 由当前硬编码 `'baseline-dense'` 改为 CLI 驱动。**baseline 文件保持冻结**，新结果写新文件。
- **D6 — 逻辑复用**：抽共享 `retrieve()`，线上 agent 与 eval 同源，避免两处逻辑漂移。

### 2.2 文件级改动

**新增**
- `src/retrieval/pipeline.ts` — 检索管线 + `ScoredChunk` 返回类型
- `src/retrieval/types.ts`（可选）— 共享类型

**修改**
- `src/config.ts` — `RetrievalConfig` + `getRetrievalConfig()` env 解析
- `src/retrieval/index.ts` — `search_documentation` 改用 pipeline；空结果返回「改写 query 重试」提示（替换第 47 行 `similaritySearch(query, 4)`）
- `evals/retrieval/run.ts` — strategy CLI + `retrieveThresholdMMR` 分支；`retrievalStrategy` 取自 CLI
- `evals/retrieval/types.ts` — `EvalConfig` 增补 `scoreThreshold`/mmr 字段
- `.env.example` — 新增 `RETRIEVAL_*` 段
- `Makefile` — eval 目标增 `STRATEGY/SCORE_THRESHOLD/MMR_LAMBDA` 变量（可选）
- `evals/baselines/retrieval/threshold-mmr-YYYYMMDD.json` + `evals/baselines/README.md` 表行 — 新 baseline
- `docs/retrieval-strategy-upgrade.md` — Phase 1 完成后勾选 + 记录阈值标定结论

### 2.3 实施步骤（每步一个 gate）

1. 配置层（config + env）→ `pnpm run typecheck`
2. pipeline（retrieve + MMR + 阈值）→ `pnpm run typecheck`
3. 线上接入 + 空结果提示 → `pnpm run typecheck`
4. eval 接入 strategy 分支 → 跑 `pnpm run eval:rebuild` 复现 baseline（确认与 frozen 一致）
5. A/B 多组参数 → 存新 baseline → 更新 README/docs
6. 复盘：按 type/difficulty/bad case 分析，写阈值标定结论

### 2.4 评测与 A/B

```bash
# 复现 baseline（确认环境一致）
pnpm run eval:rebuild -- --json > eval-results/baseline-repro.json

# 阈值网格扫描（复用索引，无需 rebuild）
for t in 0.50 0.55 0.60 0.65; do
  pnpm run eval:json -- --strategy threshold-mmr --score-threshold $t --mmr-lambda 0.7 > eval-results/phase1-$t.json
done

# 选定阈值后跑最终策略
pnpm run eval -- --strategy threshold-mmr --score-threshold <选定值> --mmr-lambda 0.7
```

对比维度（对齐 evaluation-plan §6）：Hit@4、Precision@4、MRR、NDCG@10、Keyword Recall；按 type / difficulty；关注 easy 是否退化、失败 query 是否减少、unanswerable abstention 是否受影响。

---

## 3. 预期

### 3.1 成功标准

- Hit@4 **≥ 89.2%** 且 MRR **≥ 0.652**（相对 baseline 不退化）
- Precision@4 **上升**（去冗余的直接体现）
- easy 段不退化
- 阈值默认值由 `0.50~0.65` 网格在「不退化」约束下选定
- 阈值 + MMR 减少「相邻 chunk / JS-Python 重复页」对 top-4 的占位

### 3.2 诚实预期

阈值 + MMR 的主要收益在 **Precision 与上下文质量（去冗余）**，Hit@4 可能持平或小涨。跨语言噪声（top-1 已是 Python 页）**不是 MMR 能解决的**，留给 Phase 3 rerank / Phase 2 BM25+metadata。

### 3.3 风险与缓解

| 风险 | 说明 | 缓解 |
|------|------|------|
| 阈值误杀 | answerable topScore min=0.629，阈值 ≥0.65 有丢命中风险 | 保守默认 0.55 + 网格验证 |
| MMR 重算分差异 | `cosineSimilarity` 重算 query 分与 Qdrant 分数有细微差异 | 只影响排序不影响正确性，记录即可 |
| 额外 embedding | fetchK=20 需一次 batch `embedDocuments` | 延迟/成本略增，可接受 |

---

## 4. 已定案决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 阈值默认值 | 先跑 `{0.50, 0.55, 0.60, 0.65}` 网格，由 Hit@4/Precision@4 数据选定，不预设 0.55 |
| 2 | topK/fetchK 可配置化 + 空结果处理 | **纳入** Phase 1（design doc 第 3、4 条） |
| 3 | baseline 记录 | 记录 Phase 1 新 baseline（`threshold-mmr-YYYYMMDD.json`），**不覆盖** 原始 `baseline-dense-20260813.json`，只在 README 表新增行 |
