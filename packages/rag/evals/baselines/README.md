# RAG Evaluation Baselines

本目录保存 RAG 评测的基准结果，按评测层级分为：

- `retrieval/` — 检索评测 baseline（Hit Rate、MRR、NDCG、Precision 等）
- `generation/` — 生成评测 baseline（Faithfulness、Relevance、Abstention 等）

**Baseline 一经冻结不再修改**，后续检索策略优化（混合检索、rerank、metadata 过滤等）均与此对比。

## 运行方式

```bash
cd packages/rag
pnpm eval                              # 文本报告
pnpm eval --json                       # JSON 输出
pnpm eval --rebuild                    # 强制重建向量索引
pnpm eval --type troubleshooting       # 按类型过滤
pnpm eval --difficulty hard            # 按难度过滤
pnpm eval --abstention-threshold 0.75  # 自定义 abstention 阈值
pnpm eval --strategy threshold-mmr --score-threshold 0.55 --mmr-lambda 0.9
```

## Baseline 列表

| 文件 | 日期 | Dataset | 策略 | Query | Hit@4 | Prec@4 | MRR | NDCG@10 | Abstain |
|------|------|---------|------|-------|-------|--------|-----|---------|---------|
| `retrieval/hybrid-rerank-20260816.json` | 2026-08-16 | v2 | hybrid-rerank (experimental, 关) | 44 (37+7) | 89.2% | 39.9% | 0.683 | 0.390 | **100%** |
| `retrieval/hybrid-rewrite-20260816.json` | 2026-08-16 | v2 | hybrid-rewrite（生产默认） | 44 (37+7) | **91.9%** | 41.2% | 0.684 | **0.393** | **100%** |
| `retrieval/hybrid-bm25-20260816.json` | 2026-08-16 | v2 | hybrid-bm25 (ablation) | 44 (37+7) | 91.9% | 40.5% | 0.662 | 0.381 | 85.7% |
| `retrieval/baseline-dense-20260813.json` | 2026-08-13 | v2 | baseline-dense | 44 (37+7) | 89.2% | 41.2% | 0.652 | 0.380 | 85.7% |
| `retrieval/threshold-mmr-20260814.json` | 2026-08-14 | v2 | threshold-mmr 0.55/0.7 (rejected) | 44 (37+7) | 83.8% | 36.5% | 0.577 | 0.209 | 85.7% |
| `retrieval/threshold-mmr-lambda090-20260814.json` | 2026-08-14 | v2 | threshold-mmr 0.55/0.9 (experimental) | 44 (37+7) | 89.2% | 39.9% | 0.628 | 0.230 | 85.7% |

## 2026-08-16 Phase 3 Cross-encoder Rerank 精排（实验性，默认关闭）

Phase 3 在 Phase 2 混合检索（Dense + BM25 Boost + Query Rewrite）的基础上，引入 DashScope `qwen3-rerank` Cross-encoder 模型对 top-fetchK 候选进行精排。两阶段检索架构：Bi-encoder 负责高效粗筛（~3000 → 20），Cross-encoder 负责精细排序。

**最终判定：⚠️ 模型效果未达预期，功能框架已就绪但默认关闭。** 代码保留为 experimental，待更换更高质量 reranker 模型（如 bge-reranker-v2 或中文微调模型）或积累更多训练数据后再评估启用。

### 核心发现：为什么 qwen3-rerank 没有带来净增益

经过多轮消融实验（含 deterministic 对比——关闭 Query Rewrite，确保候选池 100% 一致），发现以下问题：

1. **Rerank Drift（排序漂移）**：初版实现用 rerank 分数**完全替换** bi-encoder 分数，导致 cross-encoder 将"宽泛语义匹配"的 overview/intro 类 chunk 排到精确 API 文档前面，Hit@4 从 91.9% 骤降至 83.8%。
2. **RRF 融合无法根治**：改用 Rank-level 加权 RRF 融合（weighted RRF, k=60）后，发现不存在 sweet spot——任何能改变排序的权重都会引入新的失败（q013/q020/q023/q029），权重小到不犯错时（bi-encoder:reranker = 20:1），reranker 也无法带来任何增益。
3. **模型偏差**：qwen3-rerank 在中文技术文档场景下系统性偏好"概念介绍"类 chunk 而非"具体 API 用法"类 chunk，这与我们的 ground truth 标注偏好（精确答案优先）存在系统性偏差。
4. **Rewrite 方差**：将 rewrite temperature 从 0.7 降至 0.1 后大幅减少了方差，但 DeepSeek API 通过 invoke 参数覆盖 temperature 仍不能保证完全确定性输出（两次独立运行结果仍有微小差异），因此 deterministic 消融（hybrid-bm25 无 rewrite）的结论更可信。

### 策略对比总览（最终配置，加权 RRF 20:1）

| 指标 | hybrid-rewrite（生产默认，冻结） | hybrid-rerank（experimental） | 变化 |
|------|-------------------------------|------------------------------|------|
| Hit@4 | **91.9%** | 89.2% | ↓2.7pp |
| Hit@10 | **97.3%** | 97.3% | 持平 |
| Hit@20 | 100% | **100%** | 持平 ✅ |
| Prec@4 | **41.2%** | 39.9% | ↓1.3pp |
| MRR | **0.684** | 0.683 | ≈持平 |
| NDCG@4 | 0.449 | 0.445 | ≈持平 |
| NDCG@10 | **0.393** | 0.390 | ≈持平 |
| Keyword Recall | 57.7% | 57.7% | 持平 |
| Duplicate Ratio@4 | 8.1% | 8.1% | 持平 |
| **Abstention Rate** | **100%（7/7）** | **100%（7/7）** | 持平 ✅ |
| Answerable failures | 3 | 4 | +1（q013） |

### Deterministic 消融验证（hybrid-bm25 无 rewrite，候选池 100% 相同）

这是最严谨的 A/B 对比——关闭 Query Rewrite，两次检索的 dense+BM25 候选池完全一致：

| RRF 权重 (bi-encoder : reranker) | Hit@4 | MRR | 新失败 query | 结论 |
|----------------------------------|-------|-----|-------------|------|
| 无 rerank（baseline） | **91.9%** | **0.664** | — | 基准 |
| 1:1（等权 RRF k=60） | 83.8% | 0.623 | q013/q020/q023/q029 (+4) | ❌ 严重退化 |
| 2:0.3（7:1） | 89.2% | 0.660 | q013 (+1) | ❌ 仍引入退化 |
| 3:0.15（20:1，安全值） | **91.9%** | **0.664** | 无 | ✅ 不退化但也无增益 |
| 3:0.2（15:1） | 89.2% | 0.659 | q013 (+1) | ❌ 引入退化 |

**结论**：20:1 权重是"安全线"，reranker 权重再大一点就破坏现有排序，再小一点等于没开。

### hybrid-rerank 最终配置

- 检索策略: hybrid-rerank（Dense + BM25 Boost + Query Rewrite + qwen3-rerank + Weighted RRF）
- Rerank 模型: DashScope qwen3-rerank，原生 HTTP API，10s 超时，失败自动 fallback
- **融合策略: Weighted RRF**（k=60, bi-encoder weight=3.0, reranker weight=0.15，约 20:1）
  - 初版使用 rerank 分数完全替换 bi-encoder 分数，导致 Hit@4 暴跌 8pp（Rerank Drift）
  - 改为 RRF 后仍需保守权重才能不引入回归
- Fetch K: 20（粗筛后送入 reranker），Rerank 返回全量 20 条重排，最终 Top K: 4
- Score 语义：`score` 为 RRF 融合分；`denseScore` 保持原始 cosine 用于 abstention 判断；新增 `rerankScore` 字段
- Query Rewrite temperature: 从全局默认 0.7 降至 **0.1**（通过 invoke 参数覆盖），减少 API 名称泛化
- 向量库: Qdrant `langchain_docs`（2681 chunks，**未重建**，复用 Phase 2 索引）
- **开关状态: 默认关闭**（`RETRIEVAL_RERANK_ENABLED=false`）
- Query 数: 44（37 answerable + 7 unanswerable）
- Abstention threshold: topScore (dense cosine) < 0.78

### 工程产出（可复用）

虽然 qwen3-rerank 模型在当前场景下未带来净增益，但以下工程框架已完成并可复用：

1. **[rerankers/index.ts](../../src/retrieval/rerankers/index.ts)**：通用 `Reranker` 接口 + DashScope HTTP 客户端实现（超时、错误处理、fallback），接入新 reranker 只需实现 `rank()` 方法。
2. **[pipeline.ts](../../src/retrieval/pipeline.ts#L59-L108)**：Weighted RRF 融合层，可通过 `BI_ENCODER_WEIGHT`/`RERANK_WEIGHT` 常量调节权重比。
3. **[config.ts](../../src/config.ts)**：完整的 rerank 配置段（enabled/model/topN/rerankUrl）+ MMR 互斥校验 + 环境变量解析。
4. **[types.ts](../../src/retrieval/types.ts)**：`ScoredChunk.rerankScore` 字段用于观测调试。
5. **[transformers/rewrite.ts](../../src/retrieval/transformers/rewrite.ts#L31-L34)**：Query Rewrite temperature 从 0.7 降至 0.1，改善 API 名称保留。
6. **Bug 修复**：初版 rerank 只返回 `topN=4` 条导致 Hit@10/@20 指标失真（已修复，返回全量重排列表）。

### 失败分析（4 条，最终配置）

| ID | 问题 | 类型/难度 | hybrid-rewrite | hybrid-rerank | 分析 |
|----|------|----------|---------------|--------------|------|
| q001 | 子代理流式传输 | api_usage/medium | ❌ MISS | ❌ MISS | Python rag 文档噪声，需 metadata 语言过滤 |
| q013 | astream_events 监听 | api_usage/hard | ✅ HIT | ❌ **新失败** | reranker 将 models chunk 排到 streaming 前面，权重 20:1 仍无法完全抑制 |
| q026 | 工具结果不在历史 | troubleshooting/hard | ❌ MISS | ❌ MISS | 跨模块混淆，需 metadata 模块路由 |
| q031 | streaming 回调不触发 | troubleshooting/hard | ❌ MISS | ❌ MISS | langgraph vs langchain streaming 混淆 |

### 后续方向

1. **更换 reranker 模型**：尝试 bge-reranker-v2-m3（多语言）或专门针对中文技术文档微调的 reranker，这是解决模型偏差的根本路径。
2. **Metadata `language` 过滤**：对 JS 文档查询预过滤 `language=javascript`，优先解决 q001 这类跨语言噪声（不依赖 reranker）。
3. **Metadata `module` 路由**：识别 query 所属模块（langchain/langgraph/deepagents），在向量检索前加 metadata filter，解决 q026/q031 跨包混淆。
4. **Rewrite temperature 独立配置**：当前通过 invoke 参数覆盖 temperature，若 LangChain 版本升级导致参数传递失效，应创建独立的低 temperature LLM 实例用于 rewrite。
5. **Rewrite 磁盘缓存**：在 eval 场景下将 rewrite 结果写入磁盘缓存，确保 A/B 对比在完全相同的候选池上进行。

## 2026-08-16 Phase 2 混合检索 + Query Rewrite

Phase 2 引入了两项核心能力：(1) Dense + BM25 Sparse 混合检索（Score-level Boost Fusion），(2) 基于 DeepSeek 的 Query Rewrite。评测结果显示两种策略各有优劣，形成 Precision–Abstention trade-off。

### 策略对比总览

| 指标 | baseline-dense (08-13) | hybrid-bm25 (ablation) | hybrid-rewrite（生产默认） |
|------|----------------------|----------------------|------------------------|
| Hit@4 | 89.2% | **91.9%** ↑ | 89.2% |
| Hit@10 | 94.6% | 94.6% | **97.3%** ↑ |
| Hit@20 | 97.3% | 97.3% | **100%** ↑ |
| Prec@4 | 41.2% | 40.5% | 39.2% |
| MRR | 0.652 | **0.662** | 0.646 |
| NDCG@10 | 0.380 | **0.381** | 0.372 |
| Keyword Recall | 57.7% | 58.3% | 57.7% |
| Duplicate Ratio@4 | 10.8% | 10.1% | **8.8%** |
| Context Quality@4 | 36.8% | 37.8% | 37.5% |
| **Abstention Rate** | 85.7%（6/7） | 85.7%（6/7） | **100%（7/7）** ↑ |
| Answerable failures | 4 | **3** | 4 |

**核心结论**：
- **hybrid-bm25** 在 top-4 精度上最优（Hit@4=91.9%，MRR=0.662），但 abstention 仍有 1 条漏判（q039 Pinecone 虚假置信度）。
- **hybrid-rewrite**（生产默认）虽然 top-4 精度回到 89.2%，但 Abstention 达到完美 100%，且 Hit@20=100%（深度召回无遗漏），Duplicate Ratio 最低（8.8%）。
- Query Rewrite 的副作用：将精确 API 名称（如 `astream_events`）泛化为更通用的表述，导致 BM25 精确匹配信号被削弱，引入 q013 新的 miss。

### hybrid-rewrite 配置（生产默认）
- 检索策略: hybrid-rewrite（Dense + BM25 Boost Fusion + DeepSeek Query Rewrite）
- Fetch K: 20（denseTopK=30, sparseTopK=5），Top K: 4
- 融合权重: denseWeight=2.0, sparseWeight=0.5
- Query Rewrite: DeepSeek deepseek-v4-flash，temperature=0.7，LRU 缓存 500 条，失败 fallback 原查询
- BM25 分词: 中文单字 unigram + 英文驼峰/连字符拆分，in-memory 索引（2681 chunks）
- Embedding: qwen3.7-text-embedding（DashScope，1024 维）
- 向量库: Qdrant（localhost:6333），collection `langchain_docs`（未重建，2681 chunks）
- Query 数: 44（37 answerable + 7 unanswerable）
- Abstention threshold: topScore < 0.78

### hybrid-rewrite 按类型

| 类型 | 数量 | Hit@4 | MRR | NDCG@10 | 对比 hybrid-bm25 |
|------|------|-------|-----|---------|-----------------|
| concept | 10 | 100.0% | 0.683 | 0.407 | MRR 略降 |
| api_usage | 16 | 87.5% | 0.752 | 0.389 | Hit@4 ↓6.3pp（q013 回归） |
| comparison | 6 | 100.0% | 0.500 | 0.336 | 保持 100%，MRR ↑ |
| troubleshooting | 5 | 60.0% | 0.403 | 0.288 | MRR 微升 |
| unanswerable | 7 | N/A | N/A | N/A | **Abstention 100%** ✅ |

### hybrid-rewrite 按难度

| 难度 | 数量 | Hit@4 | MRR | 对比 hybrid-bm25 |
|------|------|-------|-----|-----------------|
| easy | 9 | 100.0% | 0.704 | 保持 100% |
| medium | 20 | 75.0% | 0.592 | 持平 |
| hard | 15 | 60.0% | 0.381 | Hit@4 ↓6.7pp |

### hybrid-rewrite 失败分析（Hit@4 = 0，共 4 条）

| ID | 问题 | hybrid-bm25 结果 | hybrid-rewrite 结果 | Rewrite 影响 |
|----|------|-----------------|-------------------|-------------|
| ~~q002~~ | ~~deepagents vs Agent~~ | ✅ 已修复 | ✅ 保持修复 | Rewrite 保留了关键术语，无负面影响 |
| q001 | 子代理流式传输 | ❌ 失败 | ❌ 失败 | 无变化（Python rag 噪声问题） |
| q013 | astream_events 监听 | ✅ HIT | ❌ **新失败** | Rewrite 将 "astream_events" 泛化，丢失 BM25 精确匹配 |
| q026 | 工具结果不在历史 | ❌ 失败 | ❌ 失败 | 无变化（跨模块混淆） |
| q031 | streaming 回调不触发 | ❌ 失败 | ❌ 失败 | 无变化（langgraph vs langchain 混淆） |

### Abstention 改善分析

hybrid-rewrite 的最大亮点是 **Abstention Rate 从 85.7% 提升到 100%**，修复了 q039（"如何集成 Pinecone"）的虚假置信度问题：
- baseline-dense/hybrid-bm25：q039 的 topDenseScore=0.7885（刚好高于 0.78 阈值，产生 false confidence）
- hybrid-rewrite：Rewrite 后查询语义更聚焦，q039 的 topDenseScore 降至 0.7775（低于阈值，正确 abstain）

同时 answerable 的平均分从 0.769 微降至 0.758，unanswerable 平均分从 0.693 降至 0.672，两类分数分布的间距更明显，说明 Rewrite 有助于提升 dense embedding 的语义区分度。

### 效果提升归因（BM25 Boost 部分）

Hit@4 从 89.2% → 91.9%（hybrid-bm25 vs baseline-dense）的核心来源：

1. **BM25 关键词精确匹配（主因）**：comparison 类 query（如 "deepagents vs Agent"）通过词频信号纠正 dense embedding 在语义相近但模块不同的文档间的排序偏差。q002 直接贡献 2.7pp Hit@4。
2. **dense-first Boost Fusion 策略**：权重 4:1（dense=0.8, sparse=0.2），BM25 仅对 dense 候选做 boost 重排、不引入 sparse 独有文档，避免中文 unigram 噪音同时保持 dense 高召回底池。
3. **保守分词 + Min-Max 归一化**：中文 unigram + 英文驼峰拆分减少噪音；分数归一化消除 dense cosine 与 BM25 尺度差异。

### Query Rewrite 的 Trade-off 分析

| 正面效果 | 负面效果 |
|---------|---------|
| Abstention 100%（修复 q039 虚假置信度） | q013 从 HIT 变为 MISS（API 名称被泛化） |
| Hit@20=100%（深度召回无遗漏） | Prec@4 从 40.5% 降至 39.2% |
| Duplicate Ratio 降至 8.8% | MRR 从 0.662 降至 0.646 |
| unanswerable 分数分布更低（更易拒答） | answerable 低分段数量从 19 增至 22 |

**根因**：当前 Rewrite prompt 温度为 0.7，倾向于将查询"优化"为更书面化、更泛化的表达，这对区分 answerable/unanswerable 有利（提升语义区分度），但对需要精确 API 名称匹配的 query 会丢失关键 term，削弱 BM25 的精确匹配优势。

**后续优化方向**：降低 rewrite temperature（0.1~0.3）、在 prompt 中强制保留代码标识符/API 名称，或采用 step-back prompting 等保留实体的改写策略。

### 未解决问题

| 问题 | 现状 | 目标 |
|------|------|------|
| q001/q026 Python 文档干扰 | troubleshooting Hit@4 仍 60% | Metadata 预过滤 language=javascript → 80%+ |
| q031 langgraph vs langchain streaming 混淆 | 跨包歧义仍存在 | CrossEncoder rerank 或模块路由 |
| q013 API 名称被 rewrite 泛化 | api_usage Hit@4 回退 | Rewrite prompt 保留代码标识符 / 降低 temperature |
| answerable 低分段 | 22/37 topScore < 0.78 | 融合分数替代 pure dense score 做 abstention 判断 |
| BM25 内存索引 OOM 风险 | 2681 chunks≈82MB 安全，100k+ 有风险 | 流式构建 / 迁移 Qdrant native sparse vectors |

### 工程修复记录

评测过程中发现并修复了 retrieval pipeline 的一个 bug：[pipeline.ts](../../src/retrieval/pipeline.ts#L82) 在非 MMR 模式下 `slice(0, config.topK)` 只返回 4 个结果，导致 @10/@20 指标无法正确计算。修复后 `retrieve()` 返回完整候选列表，由生产调用方 [index.ts](../../src/retrieval/index.ts#L51) 显式 `slice(0, topK)`，不影响生产行为。

## 2026-08-14 Phase 1 Calibration（未启用）

`threshold-mmr-20260814.json` 是 Phase 1 参数网格的代表性候选结果，不是新的生产基线。0.50、0.55、0.60、0.65（固定 MMR lambda=0.7）均未满足 Hit@4、MRR、Precision@4 与 easy 不退化的成功标准，因此在线默认保持 `scoreThreshold` 未设置、`mmr.enabled=false`。

| Threshold | Hit@4 | Prec@4 | MRR | NDCG@10 | Keyword Recall | easy Hit@4 |
|-----------|-------|--------|-----|---------|----------------|------------|
| 0.50 | 83.8% | 36.5% | 0.577 | 0.209 | 65.8% | 77.8% |
| 0.55 | 83.8% | 36.5% | 0.577 | 0.209 | 65.8% | 77.8% |
| 0.60 | 83.8% | 35.1% | 0.577 | 0.203 | 65.8% | 77.8% |
| 0.65 | 67.6% | 30.4% | 0.486 | 0.177 | 59.5% | 66.7% |

隔离对照 0.55 / lambda=1.0 恢复 Hit@4=89.2%、Precision@4=41.2%，说明主要退化来自 lambda=0.7 的多样性选择，而不是 0.55 阈值。MMR 同时将 top-4 平均唯一文档数从 2.82 提升到 3.02，并将 Keyword Recall 从 57.7% 提升到 65.8%；后续需补充专门的去冗余指标后再决定是否启用。

补充 Duplicate Chunk Ratio、Unique Source Coverage 与 Generation Context Quality proxy 后，lambda 重扫描推荐 0.90 作为显式开启 MMR 时的实验参数：相对同索引 dense，Hit@4/easy 保持不变，重复率 10.8%→9.5%，unique source coverage 73.0%→75.7%，context quality 36.8%→38.1%。由于 Precision@4 仍从 41.2% 降到 39.9%，生产开关继续保持关闭。

> Context Quality 的均值提升来自 5/37 条 answerable query，另有 4 条下降、28 条不变；该 proxy 只用于低成本参数扫描，不能替代 generation eval。

## 2026-08-13 Frozen Baseline (dense, dataset v2)

### 配置
- 检索策略: baseline-dense（纯向量相似度）
- Fetch K: 20，Top K: 4
- Embedding: qwen3.7-text-embedding（DashScope，1024 维，batchSize=20）
- 向量库: Qdrant（localhost:6333），collection `langchain_docs`
- 文档总数: 58 页（JS 36 + Python 22），2681 个 chunks
- Query 数: 44（37 answerable + 7 unanswerable）
- Abstention threshold: topScore < 0.78
- Keyword recall: 仅计算 top K=4 chunks，word boundary 正则匹配

### 指标定义
- **Hit@K**: top K 中是否包含任一 expected doc（召回率）
- **Precision@K**: top K 中 expected doc chunks 占比（精确率，衡量无关 chunk 干扰）
- **MRR**: 第一个相关 chunk 的倒数排名（排序质量）
- **NDCG@K**: 归一化折损累积增益，IDCG 基于 K 个理想位置归一化（综合召回+排序，值域 [0,1]）
- **Keyword Recall**: top K chunks 中 expected keywords 的词边界匹配率
- **Abstention Rate**: unanswerable query 中 topScore < threshold 的比例

### Answerable 指标
| 指标 | @4 | @10 | @20 |
|------|-----|------|------|
| Hit Rate | 89.2% | 94.6% | 97.3% |
| Precision | 41.2% | 35.7% | 34.2% |
| NDCG | 0.426 | 0.380 | 0.361 |
| MRR | 0.652 | — | — |
| Keyword Recall | 57.7% | — | — |

### Unanswerable 指标
| 指标 | 值 |
|------|-----|
| Abstention Rate | 85.7%（6/7） |
| Answerable avg topScore | 0.769（min=0.629, max=0.866） |
| Unanswerable avg topScore | 0.693（min=0.583, max=0.789） |
| Answerable below threshold | 19/37（51%） |

> **注意**: 0.78 阈值下，19 条 answerable query（含 16 条 HIT）的 topScore 也低于阈值。说明纯 cosine similarity 分数无法可靠区分 answerable 与 unanswerable，abstention 不应仅依赖 score threshold，需结合 rerank 或 LLM judge。

### 按类型
| 类型 | 数量 | Hit@4 | Prec@4 | MRR | NDCG@10 |
|------|------|-------|--------|-----|---------|
| concept | 10 | 100.0% | 52.5% | 0.783 | 0.450 |
| api_usage | 16 | 93.8% | 40.6% | 0.738 | 0.383 |
| comparison | 6 | 83.3% | 37.5% | 0.427 | 0.346 |
| troubleshooting | 5 | 60.0% | 25.0% | 0.381 | 0.268 |
| unanswerable | 7 | N/A | N/A | N/A | N/A |

### 按难度
| 难度 | 数量 | Hit@4 | Prec@4 | MRR | NDCG@10 |
|------|------|-------|--------|-----|---------|
| easy | 9 | 88.9% | 38.9% | 0.636 | 0.383 |
| medium | 20 | 75.0% | 35.0% | 0.603 | 0.320 |
| hard | 15 | 66.7% | 31.7% | 0.421 | 0.281 |

### Answerable 失败分析（Hit@4 = 0）
| ID | 问题 | 根因 | 优化方向 |
|----|------|------|---------|
| q001 | 子代理流式传输 | Python deepagents/rag 排名高于 JS streaming | metadata 过滤 language=javascript |
| q002 | deepagents vs Agent | langchain/overview 排在 deepagents/overview 前 | BM25 关键词加权 + rerank |
| q026 | 工具结果不在历史 | 找到 deepagents/middleware 和 python/agents | 语言+模块路由 |
| q031 | streaming 回调不触发 | langgraph/streaming 排在 langchain streaming 前 | 模块消歧 / rerank |

### Unanswerable 详情
| ID | Query | Score | Top Doc | 判定 |
|----|-------|-------|---------|------|
| q030 | Qdrant collection mismatch | 0.583 | rag | ✅ abstain |
| q039 | Pinecone 集成 | 0.789 | rag | ❌ false confidence |
| q040 | Redis StateBackend | 0.761 | backends | ✅ abstain |
| q041 | AWS Lambda 部署 | 0.673 | overview | ✅ abstain |
| q042 | Prompt A/B 测试 | 0.629 | models | ✅ abstain |
| q043 | 多租户隔离 | 0.669 | backends | ✅ abstain |
| q044 | LlamaIndex 集成 | 0.747 | rag | ✅ abstain |

### 优化方向与预期指标变化
| 策略 | 预期改善 | 目标 |
|------|---------|------|
| BM25 + dense 混合检索 | q001/q002 关键词匹配 | troubleshooting Hit@4 → 80%+ |
| Metadata 预过滤 language=javascript | 消除 Python 文档噪声 | q001/q026 进入 top 4 |
| CrossEncoder rerank | 相关文档排名提升，Precision 提升 | MRR → 0.75+, Prec@4 → 55%+ |
| 置信度校准 / LLM abstention judge | q039 false confidence | Abstention Rate → 100% |

### 评测体系变更记录
- **v2 (2026-08-13)**: 冻结版本。修复 NDCG IDCG 归一化（基于 k 而非实际命中数）；keyword recall 改用 word boundary 正则并限定 top K；新增 Precision@K、score distribution、answerable low-score risk 报告；新增 7 条 unanswerable query；abstention threshold 可通过 CLI 配置。
