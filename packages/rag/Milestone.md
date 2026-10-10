# RAG 子应用里程碑记录

> 本文件记录 `packages/rag` 的重要特性迭代，按里程碑组织，与 git 提交历史、`docs/` 设计文档、`evals/baselines/` 基准报告互为参照。
>
> **开源注记（2026-08-25）**：本仓库公开前对 git 历史做了脱敏重写（剔除无关的 kafka 示例包、将历史文件中的本机用户名/绝对路径替换为占位符），全部提交哈希已改变；下文引用的哈希对应重写前的私有历史，仅作原始变更溯源记录。
>
> **维护规则：凡发生重要特性变更（新检索策略、切分/索引契约变更、评测基线更新、架构级重构等），必须在同一变更中同步追加一条里程碑记录。**

## 总览

| # | 日期 | 里程碑 | 关键提交 | 状态/结果 |
|---|------|--------|----------|-----------|
| M1 | 2026-08-12 ~ 08-13 | 项目奠基：模块化架构 + Qdrant + 基础 RAG 链路 | `56a1f64`…`cf7ec8c` | ✅ 可用 |
| M2 | 2026-08-13 | 评测体系与冻结基线（dense baseline） | `6c706dc`…`6a4f263` | ✅ 基线冻结 |
| M3 | 2026-08-14 | Phase 1：阈值过滤 + MMR 检索升级 | `a8cfc2f`…`36e0516` | ⚠️ 未过 gate，默认关闭 |
| M4 | 2026-08-16 | Phase 2：混合检索 + Query Rewrite | `aba99bd`、`bfcf530`、`1d1df89` | ✅ hybrid-rewrite 成为生产默认 |
| M5 | 2026-08-16 | Phase 3：Cross-encoder Rerank 精排 | `e03f042`、`441ff58`、`700e16d` | ⚠️ 实验性，默认关闭 |
| M6 | 2026-08-17 | 工程加固：参数化 + 单元测试 + 配置收敛 | `3aa743e`、`7d4178a`、`f35bae4` | ✅ 171 测试全绿 |
| M7 | 2026-08-18 | 切分管道：类型识别 + Splitter 插件化 + 统一 Chunk 契约 | `d4cee6a`、`e34694e` | ✅ A/B 通过，md-header-v2 成为默认 |
| M8 | 2026-09-22 | Rerank 弃答闸门：abstention 信号从 dense cosine 切换为 cross-encoder | — | ✅ 误杀 19/37 → 0/37，成为生产默认 |
| M9 | 2026-10-10 ~ | API 服务化：Koa + AG-UI 事件流 + Redis 断线续传（独立包 `packages/api`） | — | 🚧 P0-P2 完成（断线续传可用），P3 进行中 |

**当前生产配置**：hybrid-rewrite 检索策略（M4）+ `md-header-v2` 切分（M7，collection `langchain_docs_mdheader`）+ rerank 弃答闸门（M8，`qwen3-rerank` @0.52，排序不变）。

---

## M1（2026-08-12 ~ 08-13）项目奠基：模块化架构 + Qdrant + 基础 RAG 链路

**提交**：`56a1f64`（初始化工程）→ `f9eda13`（LLM/嵌入配置拆分公共库）→ `7e96981`（向量存储持久化与 rebuild）→ `84f76a3`（agent 流式输出）→ `bfd3266`（模块化重构，迁移到 `src/`）→ `6fa4ff2`（Qdrant 支持）→ `cf7ec8c`（ingestion 重构：加载/分块/元数据）

- 打通最小 RAG 链路：文档拉取 → RecursiveCharacterTextSplitter 切分（1000/200）→ 向量化 → `search_documentation` tool → agent 流式回答。
- Qdrant 双部署形态：本地 docker-compose 与生产级部署；ingestion 补充 `source`/`docPath`/`docType`/`chunkIndex` 等元数据。
- 产出总体蓝图 [docs/retrieval-strategy-upgrade.md](./docs/retrieval-strategy-upgrade.md)：五层可插拔检索管线（Query 理解 → 多路召回 → Fusion → Post-Filter → Rerank → 压缩），后续 Phase 1–4 均由此展开。

## M2（2026-08-13）评测体系与冻结基线

**提交**：`6c706dc`、`db6efa1`（retrieval 评测系统）→ `46b12ba`（不可回答查询评估）→ `a13078c`（Precision@K + 基准报告）→ `eb50121`、`b30d1c0`（generation 评测与拆分）→ `6a4f263`（移除 MemoryVectorStore，仅保留 Qdrant）

- 建立 retrieval-only 离线评测方法论（[docs/evaluation-plan.md](./docs/evaluation-plan.md)）：Hit@K / Precision@K / MRR / NDCG@K / Keyword Recall / Abstention Rate；另设 generation 评测（faithfulness / relevance）。
- 数据集 v2 冻结：44 query（37 answerable + 7 unanswerable），语料 58 页 / 2681 chunks。
- **冻结基线** `baseline-dense-20260813`（纯 dense 检索）：Hit@4 89.2% / Prec@4 41.2% / MRR 0.652 / NDCG@10 0.380 / Abstention 85.7%（q039 虚假置信度）。
- 确立纪律：baseline 一经冻结不再修改，后续所有策略优化均与此对比。

## M3（2026-08-14）Phase 1：阈值过滤 + MMR 检索升级

**提交**：`a8cfc2f`（计划）→ `147b057`（实现）→ `36e0516`（新增去冗余/上下文质量指标，MMR lambda 默认 0.9）

- 实现 `scoreThreshold` 过滤、MMR 去冗余、`topK`/`fetchK` 可配置化（`RETRIEVAL_*` env）。
- 参数网格（threshold 0.50–0.65 × lambda）**均未通过生产 gate**：0.55/0.7 组合 Hit@4 83.8%、MRR 0.577，低于冻结基线；隔离对照表明退化主要来自 lambda=0.7 的多样性选择。
- 补充 Duplicate Chunk Ratio / Unique Source Coverage / Context Quality proxy 后，lambda 校准为 0.9（重复率 10.8%→9.5%），但 Prec@4 仍下降，**生产开关保持关闭**，仅更新校准参数。
- 意义：首次完整实践「指标 gate + A/B 验证」决策流程，为后续 Phase 定标。详见 [docs/phase1-threshold-mmr-plan.md](./docs/phase1-threshold-mmr-plan.md) 与 [baselines/README](./evals/baselines/README.md)。

## M4（2026-08-16）Phase 2：混合检索 + Query Rewrite

**提交**：`aba99bd`（向量库选型报告）→ `bfcf530`（混合检索/查询改写/多查询生成）→ `1747ed7`（修复 pipeline 截断候选集的指标计算 bug）→ `1d1df89`（hybrid-bm25-rerank 策略）

- 向量库选型（[docs/vector-db-selection-report.md](./docs/vector-db-selection-report.md)）：6 候选多维对比，最终确认 **Qdrant**。
- Dense + BM25 混合检索：中文单字 unigram + 英文驼峰/连字符拆分、Min-Max 归一化、dense-first Boost Fusion（4:1）；Query Rewrite 基于 DeepSeek（LRU 缓存，失败回退原查询）。
- 评测结果（44 query，对照 dense 基线）：
  - **hybrid-bm25**（消融）：Hit@4 89.2%→**91.9%**，MRR 0.662，关键词信号纠正跨模块排序偏差；
  - **hybrid-rewrite（生产默认）**：Hit@20 **100%**、Abstention **100%**（修复 q039）、Duplicate Ratio 最低 8.8%，代价是 q013 API 名称被泛化回退。
- 结论：形成 Precision–Abstention trade-off 决策，hybrid-rewrite 冻结为生产默认。

## M5（2026-08-16）Phase 3：Cross-encoder Rerank 精排

**提交**：`e03f042`（计划）→ `441ff58`（实现）→ `700e16d`（baseline 报告与 bug 修复）

- 两阶段架构：bi-encoder 粗筛（fetchK=20）→ DashScope `qwen3-rerank` 精排 → topK=4。
- 关键发现：**Rerank Drift**——rerank 分数完全替换 bi-encoder 分数时 Hit@4 暴跌 8pp；改 Weighted RRF 后经 deterministic 消融（关闭 rewrite 保证候选池一致）证明任何有效权重都引入新失败，20:1 为「安全线」但无净增益。
- 根因：qwen3-rerank 在中文技术文档上系统性偏好概念介绍类 chunk 而非 API 用法类，与 ground truth 偏好不一致。
- **判定：默认关闭**（`RETRIEVAL_RERANK_ENABLED=false`）；`Reranker` 接口、RRF 融合层、配置段等工程框架保留可复用，待更换 reranker 模型再评估。rewrite temperature 同步降至 0.1。详见 [docs/phase3-rerank-plan.md](./docs/phase3-rerank-plan.md)。

## M6（2026-08-17）工程加固：参数化 + 单元测试 + 配置收敛

**提交**：`3aa743e`（agent 支持自定义查询参数）→ `7d4178a`（引入 Vitest，补齐 BM25/fusion/MMR/metrics 纯函数单测）→ `f35bae4`（abstention 阈值收进 `RetrievalConfig`，清理死代码）

- 检索参数从硬编码/env 散落收敛为统一 `RetrievalConfig`，agent 调用方可按查询覆盖参数。
- 建立单元测试基线（后续 M7 扩至 171 个用例全绿），为纯函数迭代提供回归保障。

## M7（2026-08-18）切分管道：类型识别 + Splitter 插件化 + 统一 Chunk 契约

**提交**：`d4cee6a`（计划落档）→ `e34694e`（实施，`md-header-v2`）

- 管道分层：`Loader → TypeDetector（四层判定）→ SplitterRegistry → Splitter → ChunkValidator`；统一 Chunk 契约（zod schema，确定性 id/contentHash，`chunkerVersion` 作为热启动守卫）。
- 技术要点：JS 版 `@langchain/textsplitters` 无 `MarkdownHeaderTextSplitter`，header 切分核（h1-h4 栈扫描、围栏跳过）仓库内自研；Qdrant 改自定义 upsert 实现「存储干净原文 + 消费侧组装 embedding 文本（sectionPath 前缀注入）」。
- **A/B 迭代**（同策略 hybrid-rewrite，dataset v2）：首轮 `md-header-v1`（h1-h4）失败——同文档 section 霸屏 top4，Hit@4 回退至 83.8%；按预设路径调 `INGESTION_MAX_HEADER_DEPTH=2` 后全面胜出：

  | 指标 | 对照·旧切分 | md-header-v2（h1-h2） | v2 复跑确认 |
  |---|---|---|---|
  | Hit@4 | 91.9% | **94.6%** | 91.9%（改写波动） |
  | Hit@10 | 97.3% | **100%** | **100%** |
  | Precision@4 | 40.5% | **45.3%** | **47.3%** |
  | Abstention@0.78 | 100% | **100%** | **100%** |

- 定案：`CHUNKER_VERSION='md-header-v2'`、默认 header 深度 2，正式 collection `langchain_docs_mdheader`（2858 chunks）；abstention 阈值 0.78 无需重标定。遗留观察：KeywordRecall -3.1pp（预期内）、q033 霸屏型失败。详见 [docs/chunking-pipeline-plan.md](./docs/chunking-pipeline-plan.md) §6。

## M8（2026-09-22）Rerank 弃答闸门：abstention 信号切换

**提交**：（本次变更，含同日 agent 提示词修复：检索无果时禁止先验知识作答、改写重试上限 2 次）

- **动机**：线上对"什么是langchain"等概念型问题误弃答。诊断证明检索命中正确、dense cosine 闸门误杀过半（19/37，51%）；阈值网格扫描（`evals/results/dense-gate-grid-hybrid-rewrite-20260922.json`）证明两分布严重重叠、无单点分界可用，且 0.78 的原标定已随 collection 漂移（2858→2981）失效（q040 越线漏判）。
- **设计**：rerank 只做闸门不做排序——Phase 3 的 Rerank Drift 教训（融合引入 Hit@4 -2.7pp）因此完全规避，检索主指标与 hybrid-rewrite 冻结基线一致。闸门对 top-fetchK 候选调 `qwen3-rerank`，`max(relevance_score) < 0.52` 弃答，API 失败回退 dense 阈值；与实验性融合 rerank（`RETRIEVAL_RERANK_ENABLED`）通过 `RETRIEVAL_RERANK_GATE_*` 解耦。
- **A/B（golden v2，44 query）**：误杀 19/37 → **0/37**，总正确率 54.5% → **86.4%**（与 dense 网格最优持平但零误杀）；漏判 1/7 → 6/7，全部为"主题相近但语料没有"难例，交由生成层兜底（analyst 判无关 + 禁止先验知识提示词）。阈值 0.52 取零误杀区间 (0.4949, 0.5327) 中点。标定数据：`evals/results/rerank-gate-calibration-20260922.json`。
- 验证：typecheck + 175 测试全绿（+4 配置用例）。已知边界：q043/q039 级深度混淆（rerank 0.92/0.89）为 score 闸门天花板，Abstention → 100% 需 LLM judge。详见 [docs/rerank-abstention-gate-plan.md](./docs/rerank-abstention-gate-plan.md)。
- **附带修复（重要）**：冒烟暴露 `rewriteQuery`/`generateMultiQueries` 用 `content.toString()` 提取 LLM 响应——agent 进程内共享 ChatOpenAI 实例返回多段 content block 数组时退化为 `"[object Object]"` 垃圾查询，导致在线检索 query 无关（dense 恒 0.5518）。新增 `extractTextContent()` 兼容两种形态，闸门决策日志（`🚪 Gate:`）常驻便于观测。
- **评审加固（2026-09-25，ocr 评审）**：① rerank 200 但空结果的退化响应原先会令 bestScore=0 恒弃答，现按 API 失败走 dense 回退；② gate 与 MMR 增设 config 互斥守卫——MMR 只返回 topK 多样性筛选结果，会饿死 fetchK 闸门候选池；③ `extractTextContent` 对未识别 content 形态告警，防静默降级重演；④ 融合 rerank 与闸门同开时同一候选池双调用为已知成本（pipeline 打分用改写后 query、闸门用原始 query，信号不同不可复用），以启动日志与计划文档 §4.2 记录。

---

## M9（2026-10-10 ~，进行中）API 服务化：Koa + AG-UI + Redis 断线续传

**技术方案**：[docs/api-service-plan.md](./docs/api-service-plan.md)（事件映射、API 契约、持久化模型、P0-P3 分阶段计划）。本条目随各阶段落地滚动更新，全部完成后终稿。

**P0 基座（2026-10-10 完成）**：

- 新增独立包 `packages/api`（`@langchain-rag/api`）：Koa 骨架 + CORS + 统一错误体 + `/health` `/ready` 探针 + 优雅停机；agent 进程内单例（构建失败不缓存、探针触发重建）；Redis 懒连接客户端（compose 新增 `redis:7-alpine`）。依赖单向 `api → rag`（`workspace:*` + rag `exports` 直指 TS 源，no-build）。
- rag 侧最小改动两处：新增库入口 `src/index.ts`（barrel：`createRagAgent` / `RagAgent` / `getRetrievalConfig`）；`createRagAgent` 参数化（`{forceRebuild?, checkpointer?}`，checkpointer 为 M9-P2 预留，CLI 不传行为零变化）。显式依赖 `@langchain/langgraph-checkpoint`（checkpointer 类型引入）。
- env 级联：api 先读自身 `.env`，再以不覆盖方式补读 `packages/rag/.env`（冒烟验证 28 项注入）。
- 验证：递归 typecheck 全绿；测试 185 全绿（rag 175 不变 + api 10 新增）；冒烟 `pnpm serve` → `/ready` 200（agent 单例 + BM25 热启动 + Redis）；CLI 回归（`pnpm rag "什么是langchain"`）完整问答链路不变。
- 检索/切分/评测路径零改动，无需 A/B（变更纪律 §1-3 不触发）。

**P1 AG-UI 事件流（2026-10-10 完成）**：

- `POST /agui`（AG-UI v1.0 HTTP+SSE binding，HttpAgent 可直连）+ `POST /threads/:threadId/runs/:runId/cancel`；SSE 帧（`@ag-ui/encoder`）、心跳、**断开 ≠ 取消**（连接关闭仅退订，run 继续执行）。
- translator（`packages/api/src/agui/translator.ts`）：消费 deepagents v3 的**单一全局有序 ProtocolEvent 流**，映射 TEXT/REASONING/TOOL_CALL/SUBAGENT/MESSAGES_SNAPSHOT/RUN_* 事件；归属规则按 namespace 深度区分主代理/子代理/工具内部 LLM（query rewrite 不映射，P3 转 retrieval.trace）。golden 单测锁定序列。
- RunManager：run 状态机、每 thread 单活跃 run（409）、进程级并发闸门（429 + Retry-After）、超时 abort、显式取消（RUN_ERROR{code:cancelled}）、优雅停机 waitIdle。
- **风险 1 前置验证闭环**（探针 `scripts/probe-v3-stream.ts`）：`deepseek-v4-flash` 确认输出 reasoning_content（REASONING_MESSAGE_* 有真实内容）；实测两个坑——tool-finished 无 tool_name（在 output.name）、task 委派的输出是 LangGraph Command（内容在 update.messages 末条）而非 ToolMessage，translator 均已兼容。
- 验证：递归 typecheck 全绿；测试 194 全绿（rag 175 + api 19：translator golden ×3、/agui 路由 ×6 含断开续跑与 cancel 幂等）；真实冒烟（"什么是langchain"）：完整事件序列、SUBAGENT_STARTED/FINISHED 严格配对（23/23）、断开 SSE 后 run 存活（同 thread 409）、cancel 终态 cancelled。

**P2 持久化与断线续传（2026-10-10 完成）**：

- **事件日志**（`persistence/`：types 契约 + memory（测试 fake）+ redis 实现）：`rag:thread:{id}:events`（Stream，entry id 即续传游标）、`rag:thread:{id}:meta`（Hash）、`rag:run:{runId}`（TTL 24h）、`rag:index:threads`（ZSet）。RunManager 改为 **XADD 先行再扇出**——SSE `id:` 帧即游标，持久化失败降级内存直发。
- **断线续传端点** `GET /threads/:id/events?afterEventId=`：先订阅（防回放丢事件）→ XRANGE 回放 → 按 eventId 去重 → 实时尾随至终态关流；无活跃 run 发完即关。
- **threads REST**：POST /threads（显式建档）、GET 列表（activeRun/status）、GET 详情、GET /messages（最近 MESSAGES_SNAPSHOT）、DELETE（含 checkpoint 清理，ShallowRedisSaver 自带 deleteThread）；POST /agui 自动建档 + title 回填首问摘要。
- **checkpointer**：ShallowRedisSaver 挂入 createRagAgent，invoke 传 `configurable.thread_id`；初始化失败降级为无持久化单轮模式（启动日志可见）。
- **重启语义**：启动扫描 `rag:run:*` running → interrupted + SETNX 幂等补发 `RUN_ERROR{code:"server_restart"}`。
- **实施发现（重要）**：`@langchain/langgraph-checkpoint-redis` 依赖 **RedisJSON**（JSON.GET/SET）——标准 Redis 7 报 `unknown command 'JSON.GET'`，compose 镜像升级为 `redis:8-alpine`（开源版已内置 JSON 模块）后解决。
- 验证：测试 206 全绿（rag 175 + api 31，含真实 Redis 集成 4 例、回放/尾随/两轮对话/删除等 12 新例）；真实验收——刷新回放（断开时 1729 事件 → 重连回放+尾随至 FINISHED、id 零重复）、两轮对话（第二轮复述首问 + 首轮 `/retrieved/` 文件跨轮可读，风险 3 闭环）、kill -9 重启（interrupted 标记 + server_restart 补发 + 同 thread 可续问）。

**待实施**：P3 加固（retrieval.trace CUSTOM 事件、长会话日志压缩、鉴权挂载）。

---

## 维护规则

1. **同步记录**：发生重要特性变更时（包括但不限于：新增/变更检索策略、切分与索引契约变更、评测基线冻结或更新、架构级重构、重要模型/供应商切换），必须在**同一变更**中于本文件追加里程碑记录，包含：日期、关联提交、变更内容、验证结果（评测数据或 gate 结论）、参考文档链接。
2. **诚实记录负结果**：实验未达预期的迭代（如 Phase 1、Phase 3）同样记录，写明失败原因与保留的工程产出，避免重复踩坑。
3. **总览同步**：新增里程碑时同步更新顶部总览表与「当前生产配置」说明。
4. **数据可溯源**：指标数据须引用 `evals/baselines/`、`evals/results/` 下的结果文件或对应设计文档章节，不得凭记忆填写。
