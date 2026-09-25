# Rerank 弃答闸门（Rerank Abstention Gate）实施记录

> 状态：已实施（2026-09-22），成为生产默认。关联里程碑 M8。

## 1. 背景与动机

线上 agent 对"什么是langchain"等**宽泛概念型问题**误触发弃答（"无结果返回"）。诊断结论（数据见 `evals/results/dense-gate-grid-hybrid-rewrite-20260922.json`）：

- 检索本身正常（精准命中 `langchain/overview` 等正确文档），问题出在 abstention 闸门信号。
- 原闸门用 `getMaxDenseScore`（dense cosine）对照阈值 0.78：该阈值按 golden 数据集标定时只留了 ~1.5pp 余量（unanswerable 上限 0.7654），宽泛/概念型查询的 cosine 天然落在 0.68~0.76 区间，导致 **19/37（51%）answerable 查询被误杀**（含英文原版查询，跨语言损失仅 ~1.5pp，非主因）。
- 阈值网格扫描（0.60~0.80）证明 dense cosine 的 answerable / unanswerable 分布**严重重叠，不存在可用的单点分界**——与 `baselines/README.md` v2 报告的早期结论一致。
- 附带发现：语料含 CSS/SVG/JSX 噪声（如 `frontend/subagent-streaming` 页），压低有效 chunk 的匹配分；collection 已从基线冻结时的 2858 漂移至 2981 vectors，q040 分数越线成为新漏判。

## 2. 方案设计

**核心决策：rerank 只做闸门信号，不进融合排序。**

Phase 3 已证明 qwen3-rerank 进 RRF 融合会引入 Hit@4 回退（91.9% → 89.2%，Rerank Drift）。本方案完全不动排序（检索主指标零变化、无需重冻基线），只在 agent 的 `search_documentation` 工具里：

1. `retrieve()` 照常（hybrid-rewrite）；
2. 取 top-`fetchK` 候选，用 `composeSearchText` 组装文本（与 embedding/BM25 输入同构，沿用 Phase 3 决策 D3）；
3. 调 qwen3-rerank 打分，`max(relevance_score) < RETRIEVAL_RERANK_GATE_THRESHOLD` 则弃答；
4. rerank API 失败自动回退原 dense cosine 阈值（与管线 fusion rerank 的容错策略一致）。

两级弃答防御：闸门拦"明显无关"，主题相近但语料没有的难例（Pinecone/Redis/Lambda 等）交给生成层（chunk-analyst 判无关 + 系统提示词禁止先验知识作答，同日已修复）。

配置（`RetrievalConfig.rerankGate`）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RETRIEVAL_RERANK_GATE_ENABLED` | `true` | 闸门开关（与实验性融合 rerank `RETRIEVAL_RERANK_ENABLED` 解耦） |
| `RETRIEVAL_RERANK_GATE_THRESHOLD` | `0.52` | 2026-09-22 标定 |

注意：每个 search 请求新增 1 次 rerank API 调用（20 docs），失败不影响可用性（200 但无 results 的退化响应视同失败，走 dense 回退）。与 `RETRIEVAL_MMR_ENABLED` 互斥（config 守卫）；与融合 rerank（`RETRIEVAL_RERANK_ENABLED`）同开合法，但每次 search 会对同一候选池调两次 rerank API（信号不同不可复用，见 §4.2 #3）。

## 3. 标定与 A/B 结果

标定方法：golden 数据集 v2（44 = 37 answerable + 7 unanswerable）逐条走 agent 同路径（hybrid-rewrite 检索 + rerank 闸门打分），原始数据 `evals/results/rerank-gate-calibration-20260922.json`。

分数分布：answerable 0.4949~0.9700，unanswerable 0.3477~0.9252（重叠区集中在"主题相近"难例）。

| 闸门方案 | 误杀（answerable 被拦） | 漏判（unanswerable 放行） | 总正确率 |
|---|---|---|---|
| dense cosine @0.78（原生产） | **19/37** | 1/7 | 54.5% |
| dense cosine 网格最优 | 1/37（t=0.60） | 5/7 | 86.4% |
| **rerank @0.52（新生产）** | **0/37** | 6/7 | **86.4%** |
| rerank @0.55 | 3/37 | 4/7 | 84.1% |
| rerank @0.65 | 4/37 | 3/7 | 84.1% |

- 0.52 取零误杀区间 (0.4949, 0.5327) 中点，两侧余量 ~1.5~2.5pp。
- 漏判 6 条全部是"主题相近但语料确实没有"的难例（q039 Pinecone、q040 Redis、q041 Lambda、q043 多租户等），由生成层兜底；其中 q043（0.9252）、q039（0.8904）属于 cross-encoder 也无法分辨的深度混淆，是后续 LLM-judge 方向的已知边界。
- 排序不变 ⇒ Hit@4 / MRR 等检索主指标与 hybrid-rewrite 冻结基线一致，无需重扫。

## 4. 验证

- `pnpm typecheck && pnpm test`：175 用例全绿（新增 rerankGate 配置解析/校验/互斥守卫 4 例）。
- 评测器 abstention 指标语义不变（仍基于 dense cosine 的 topScore）；rerank 闸门作为 agent 在线行为单独标定，`evals/retrieval/run.ts` 中显式 `rerankGate.enabled=false`。
- 端到端冒烟（`pnpm rag "什么是langchain"`）：7 次 search 全部正确放行（rerank 0.55~0.95），agent 基于索引文档带引用回答，未使用先验知识。

### 4.1 冒烟过程中发现并修复的隐藏 Bug：rewrite content 提取

首轮流闸门冒烟中，agent 进程内所有 search 的 `maxDenseScore` 恒为 0.5518、top-1 恒为 `langchain/tools`——检索退化为 query 无关。闸门日志（`🚪 Gate:` 行）定位到 `transformQueries` 输出为字面量 `"[object Object],[object Object]"`：`rewriteQuery` 用 `response.content.toString()` 提取文本，而 agent 进程内共享的 ChatOpenAI 实例（被 deepagents 包装）返回**多段 content block 数组**，数组 `toString()` 即产生该垃圾字符串并污染 embedding 查询。此前所有离线诊断/标定脚本恰好走了 content 为 string 的路径，从未暴露。

修复：`extractTextContent()`（兼容 string 与 `{text}` 块数组，导出于 `rewrite.ts`），`rewriteQuery` 与 `generateMultiQueries` 统一改用。这也解释了为什么该 bug 此前只在 agent 在线链路可见。

### 4.2 ocr 评审修复（2026-09-25）

用 OpenCodeReview（`ocr review`）对本次变更做 AI 评审，5 条发现全部处置：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | bug·中 | rerank HTTP 200 但缺 `output.results` 时 `rank()` 返回 `[]`，`bestRerankScore` 归零 → 恒弃答，恰是本方案要消除的故障模式 | `results.length === 0` 时 throw，落入既有 catch 走 dense 回退 |
| 2 | bug·低 | gate+MMR 组合下 `retrieve()` 只返回 topK 多样性筛选块，违背 top-fetchK 契约、偏向误弃答 | config 层互斥守卫（沿 rerank+MMR 先例）+ 单测 |
| 3 | perf·中 | 融合 rerank 与 gate 同开时，pipeline 与闸门对同一候选池各调一次 rerank API，延迟/费用翻倍 | **不改代码**：pipeline 用改写后 primaryQuery 打分、闸门用原始 query，信号不同，复用 `rerankScore` 会使 0.52 标定失效（须重新 A/B）。以启动日志 ⚠️ 提示与本文档记录为已知成本 |
| 4 | maint·低 | `getMaxDenseScore` 全量扫描重复计算两次；`🚪 Gate:` 日志单行 ~450 字符难读难 diff | 提升为局部变量；日志拆分并命名 `topDocPath`/`decision`（字段与顺序保持不变） |
| 5 | maint·低 | `extractTextContent` 对未识别形态静默返回 `''`——正是 §4.1 bug 长期未暴露的失败模式 | 兜底分支加 `console.warn` |

## 5. 遗留与后续

- 生成层 abstention 的端到端验证（`pnpm eval:gen` 的 Abstention Rate）待跑，预期漏判 6 条由 faithfulness/analyst 兜底。
- 语料噪声治理（剥离 CSS/SVG/JSX 后重切分）单独立项，属切分契约变更，需 `--rebuild` + 全量 A/B。
- q043/q039 级别的深度混淆是 score-based 闸门的天花板，如需 Abstention Rate → 100% 须上 LLM judge。
