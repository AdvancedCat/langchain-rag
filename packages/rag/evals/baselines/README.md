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
```

## Baseline 列表

| 文件 | 日期 | Dataset | 策略 | Query | Hit@4 | Prec@4 | MRR | NDCG@10 | Abstain |
|------|------|---------|------|-------|-------|--------|-----|---------|---------|
| `retrieval/baseline-dense-20260813.json` | 2026-08-13 | v2 | baseline-dense | 44 (37+7) | 89.2% | 41.2% | 0.652 | 0.380 | 85.7% |

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
