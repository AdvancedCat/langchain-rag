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
| `retrieval/baseline-dense-20260813.json` | 2026-08-13 | v2 | baseline-dense | 44 (37+7) | 89.2% | 41.2% | 0.652 | 0.380 | 85.7% |
| `retrieval/threshold-mmr-20260814.json` | 2026-08-14 | v2 | threshold-mmr 0.55/0.7 (rejected) | 44 (37+7) | 83.8% | 36.5% | 0.577 | 0.209 | 85.7% |
| `retrieval/threshold-mmr-lambda090-20260814.json` | 2026-08-14 | v2 | threshold-mmr 0.55/0.9 (experimental) | 44 (37+7) | 89.2% | 39.9% | 0.628 | 0.230 | 85.7% |

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
