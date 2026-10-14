# 扣子罗盘（CozeLoop）可观测性接入方案

> 状态：P0 已实施（2026-10-13），回填见 §8。真实 PAT 冒烟待用户执行。
> 关联：`packages/rag/Milestone.md` M11；[扣子罗盘 Node.js 快速开始](https://docs.coze.cn/cozeloop_quick-start-nodejs)、[cozeloop-js 仓库](https://github.com/coze-dev/cozeloop-js)。

## 1. 背景与目标

当前 agent 的运行时观测只有 console 日志（如 `🚪 Gate:` 弃答闸门、`[Rerank] API failed`），服务化（M9）之后缺少：

- **全链路 trace**：一次问答里主模型、query rewrite、检索各阶段、rerank、子代理（chunk-analyst）的耗时与调用关系没有统一视图；
- **LLM 成本观测**：token 用量、首 token 延迟（TTFT）无沉淀；
- **检索质量在线归因**：弃答闸门的决策（rerank 分数、阈值、命中文档）只打了本地日志，`api-service-plan.md` 规划的 `retrieval.trace` CUSTOM 事件（M9-P3）也尚未实施。

目标：接入扣子罗盘（CozeLoop）可观测 SDK，为 **CLI（`pnpm rag`）与 API 服务（`pnpm serve`）** 两条入口提供 per-run 的完整 span 树，覆盖 LLM 调用（含 token/TTFT）与检索管线全阶段。

非目标（P1+）：embedding/ingestion 埋点、web→api 跨端 trace 透传、评测批跑上报、Prompt Hub、`retrieval.trace` AG-UI CUSTOM 事件（与 spans 互补，前端展示用，另行实施）。

## 2. SDK 调研结论（@cozeloop/ai v0.0.11）

文档站（loop.coze.cn / docs.coze.cn）为 SPA，正文以 npm 包类型定义与编译产物核实为准：

| 项 | 结论 |
|---|---|
| 包 | `@cozeloop/ai@^0.0.11`，Node ≥18，ESM 可用（`dist/index.mjs`），peer 依赖 `axios@^1.7.1` 需宿主提供 |
| 初始化 | `cozeLoopTracer.initialize({ workspaceId?, apiClient?, ultraLargeReport?, recordInputs?, recordOutputs?, processor? })`；**幂等**（二次调用直接返回）；**缺 workspaceId 抛 `PropertyUnprovidedError`** → 必须前置 gate |
| 环境变量 | `COZELOOP_API_BASE_URL`（默认 `https://api.coze.cn`）、`COZELOOP_API_TOKEN`（PAT）、`COZELOOP_WORKSPACE_ID`，SDK 自读 |
| span API | 高层 `cozeLoopTracer.traceable(fn, opts)` 包裹函数：自动创建/结束 span、序列化入参为 input/返回值为 output；`opts`：`name`、`type`（`SpanKind.Model/Retriever/Tool/PromptHub/PromptTemplate` 或任意 string）、`attributes`、`baggages`（`user_id/message_id/thread_id/...` 子 span 自动继承）、`recordInputs/Outputs`、`endWhenDone` |
| 数据 API | `setInput/setOutput(span, v)`、`setTags(span, {...})`（类型化业务 tag：`MODEL_NAME/INPUT_TOKENS/OUTPUT_TOKENS/TOKENS/CALL_OPTIONS/START_TIME_FIRST_RESP/STREAM/RETRIEVER_PROVIDER/...`）、`setError(span, msg?)` |
| 底层 | `cozeLoopTracer.getTracer()` 返回标准 OTel Tracer——**start/end 分离的场景可手动 `startSpan`**（需自设 `cozeloop_span_name/cozeloop_span_type` 属性，OTel span 名为 `${name}.${type}`） |
| 上下文 | 内部是 OTel NodeSDK + AsyncLocalStorage 上下文管理器；**同一条异步调用链自动父子嵌套**，无需传参 |
| 生命周期 | `forceFlush()` / `shutdown()`——CLI 退出、服务优雅停机必须调用，否则批量缓冲丢失 |
| 容错 | 上报失败不抛错，仅打 `[cozeloop]` 日志，不影响业务主流程 |
| LLM 展示 | model span 的 input/output 用 `LoopTraceLLMCallInput`（`{messages, tools?}`）/ `LoopTraceLLMCallOutput`（`{choices}`）结构可获得更好 UI |

**关键坑**：OTel API 是全局单例语义，宿主代码**不得**直接依赖 `@opentelemetry/api`（依赖树里会出现第二个实例，context 不互通）——一律从 `@cozeloop/ai` 的 re-export（`context`、tracer）走。

## 3. 总体设计

### 3.1 模块与依赖

```
packages/rag/src/observability/          # 新增（依赖只落在 rag 包，api 经 barrel 复用）
├── cozeloop.ts        # initCozeLoop()（幂等 gate）、isCozeLoopEnabled()、shutdownCozeLoop()
├── spans.ts           # withCozeLoopSpan() 包装器 + 输出脱敏 helpers（chunk 摘要/文本截断）
├── langchain-handler.ts  # CozeLoopLangChainCallbackHandler（LLM/tool span，run_id 幂等）
└── __tests__/         # vitest，vi.mock('@cozeloop/ai')
```

- `packages/rag/package.json`：+ `@cozeloop/ai`、+ `axios`（peer 显式化）。
- `packages/libs/llm-provider.ts`：`getLLM()` 增加可选 `{ callbacks }`（构造器注入，向后兼容）。**为什么挂在 LLM 实例上**：`search_documentation` 工具内部对 rewrite/multiQuery 的 `llm.invoke()` 不在 graph 的 config 传播链上，streamEvents 级 callbacks 捕获不到；实例级注入才能全覆盖（主模型、rewrite、multiQuery、子代理共用同一实例）。
- api 与 CLI 的 `streamEvents` 选项同时传同一 handler 实例（补 tool span / graph 结构）——与实例级注入可能重叠，靠 run_id 幂等去重（见 §3.4）。

### 3.2 开关与降级（零侵入原则）

```
COZELOOP_ENABLED         # 缺省 auto：token+workspace 齐备即启用；显式 true/false 覆盖
COZELOOP_API_TOKEN       # PAT（SDK 自读，gate 检查用）
COZELOOP_WORKSPACE_ID    # SDK 自读
COZELOOP_API_BASE_URL    # 可选，默认官方 SaaS
COZELOOP_ULTRA_LARGE_REPORT  # 可选，>1MB input/output 走文件上报，默认 false
```

- 未启用时：`initialize` 不调用、handler 不注册、`withCozeLoopSpan` 直接执行原函数（一次布尔判断开销），**行为与现状完全一致**——评测批跑（默认无 COZELOOP 配置）零影响。
- 上报链路故障：SDK 内部吞错打 `[cozeloop]` 日志，业务无感。

### 3.3 Span 树设计

```
rag-agent.run (custom, root, baggages: thread_id/run_id)      ← api RunManager.execute
├─ llm.* (model, tags: model_name/input_tokens/output_tokens/start_time_first_resp/stream)
│    ← 回调 handler：主模型 / rewrite / multiQuery / chunk-analyst 全部 LLM 调用
├─ search_documentation (tool)                                 ← 工具体外层 withCozeLoopSpan
│   ├─ retrieval (retriever, attrs: top_k/fetch_k/hybrid/rerank 等, output: top chunk 摘要)
│   │   ├─ retrieval.transform_queries (retriever, output: 变换后 queries)
│   │   │    └─ llm.*（rewrite/multiQuery，自动嵌套）
│   │   ├─ retrieval.dense ×N (retriever, attrs: query/k, output: 命中数)
│   │   ├─ retrieval.bm25 (retriever, 含 boost 融合；attrs: sparse_top_k, output: hits/boost_weight)
│   │   ├─ retrieval.rerank (retriever, attrs: model/top_n/candidates, output: top 分数摘要)
│   │   └─ retrieval.mmr (retriever, attrs: lambda/top_k, output: selected/from)
│   └─ retrieval.gate (retriever, attrs: threshold,            ← 弃答闸门（与 retrieval 同级，
│                          output: {decision, best_rerank_score, top_doc_path, candidates}）
├─ task.chunk-analyst (tool)                                   ← deepagents 子代理，§7.2
│   └─ llm.*（chunk-analyst 全部 LLM 调用，经 ALS 自动嵌套）
└─ …
rag-agent-cli.run (custom, root)                               ← packages/rag CLI（每条 query）
```

实施与初稿的两处偏差：BM25 检索与 boost 融合合并为单个 `retrieval.bm25` span（融合为亚毫秒纯函数，单独 span 是噪音）；`retrieval.fusion` 不再单独存在。闸门 span 与 retrieval span 同级（gate 在 `retrieve()` 返回后才执行，此时 retrieval span 已结束），均挂于 tool span 之下。

- span 名/类型沿用 §2 规范；`retriever` 型 stages 挂 `RETRIEVER_PROVIDER=qdrant`。
- 根 span `recordInputs/Outputs: false` + 手动 `setInput({query, runId, threadId})` / `setOutput({status, error?})`（避免序列化 `ActiveRun` 内部结构）。

### 3.4 回调 handler 与并发安全

- `handleLLMStart/End/Error/NewToken` + `handleToolStart/End/Error`（BaseCallbackHandler 经典签名，@langchain/core 1.2.5 核实）。
- span 生命周期：start 时 `getTracer().startSpan(`${name}.${type}`, {attributes: BASIC_TAGS})`（父级取当前 active context，即根 span/工具 span 所在异步链）；`run_id → span` Map 配对 end/error；**同一 run_id 重复回调直接跳过**（幂等，消化实例级+config 级双注册的重叠）。
- token：`handleLLMEnd` 的 `output.llmOutput.token_usage`（DeepSeek OpenAI 兼容：`prompt_tokens/completion_tokens/total_tokens`）；TTFT：`handleLLMNewToken` 首帧打 `START_TIME_FIRST_RESP`（微秒）。
- input/output 转 `LoopTraceLLMCallInput/Output` 结构；并发 run 各自的 ALS 上下文天然隔离。

### 3.5 数据体积与脱敏

- chunk 类输出只上报摘要 `{docPath, source, score, rerankScore?, retrievalSource?}`，**不带 pageContent**；
- 自由文本（query、prompt、回答）截断至 `MAX_SPAN_TEXT_CHARS = 2000`；
- 语料为公开 LangChain 文档，query 为用户输入，无密钥类敏感信息；`DEEPSEEK_API_KEY` 等绝不进 span。

## 4. 实施变更列表（P0）

| # | 文件 | 变更 |
|---|---|---|
| 1 | `packages/rag/package.json` | +`@cozeloop/ai`、+`axios` |
| 2 | `packages/rag/src/observability/*` | 新模块（§3.1） |
| 3 | `packages/libs/llm-provider.ts` | `getLLM(opts?: { callbacks? })` 透传构造器 |
| 4 | `packages/rag/src/retrieval/index.ts` | `createRagAgent`：`initCozeLoop()` + 实例级 callbacks + `retrieval.gate` span（闸门决策结构化，取代纯 console） |
| 5 | `packages/rag/src/retrieval/pipeline.ts` | `retrieve()` 与各阶段包 `withCozeLoopSpan`（disabled 直通） |
| 6 | `packages/api/src/runManager.ts` | `execute()` 包根 span（baggage thread_id/run_id）+ streamEvents callbacks |
| 7 | `packages/api/src/index.ts` | 优雅停机尾部 `shutdownCozeLoop()` 刷盘 |
| 8 | `packages/rag/src/agent.ts` | CLI query 包根 span + 退出 `shutdownCozeLoop()` |
| 9 | `packages/rag/src/index.ts` | barrel 导出 observability 公共 API（api 复用） |
| 10 | `packages/rag/.env.example` | Observability 区块补 `COZELOOP_*` |
| 11 | 测试 | observability 模块单测（mock `@cozeloop/ai`）：gate/幂等、handler 生命周期与 tag、脱敏、disabled 直通 |
| 12 | 文档 | 本方案回填、`Milestone.md` M11、libs README 签名说明 |

## 5. 测试与验证

- **单测**（不碰真实罗盘服务）：`vi.mock('@cozeloop/ai')` 后断言 initialize 参数/gate、span 生命周期与业务 tag、run_id 幂等、截断与 chunk 摘要、disabled 路径不触 SDK。存量 246 用例不回归。
- **门槛**：`pnpm typecheck && pnpm test` 全绿。
- **真实验收**（需用户在 [loop.coze.cn](https://loop.coze.cn) 控制台建 workspace + PAT，填入 `.env`）：`pnpm serve` 起服务问一轮 → 罗盘 Trace 页看到完整树（root→llm/tool→retrieval→stages）、token 统计与 TTFT；`pnpm rag` 单问同验；去掉 token 验证 no-op 无报错。

## 6. 风险与注意事项

1. **SDK 早期版本（0.0.x）**：API 可能变动，锁 `^0.0.11`（语义化版本下不会自动跳 minor）；升级需回归单测。
2. **OTel 单例**：严禁直接依赖 `@opentelemetry/api`（§2 坑）；observability 模块是从 `@cozeloop/ai` 导入的唯一出口。
3. **axios peer**：显式加入 rag 依赖，避免依赖 auto-install-peers 行为。
4. **批量缓冲**：batch processor 定时上报，CLI 与服务退出路径必须 `shutdown()`；api 的 `waitIdle` 之后调用。
5. **体积**：默认不开 `ultraLargeReport`，>1MB 内容 SDK 丢弃（可接受降级）；截断策略兜底。
6. **性能**：disabled 路径一次布尔判断；enabled 路径新增 span 对象与属性序列化，属可观测常规开销。

## 7. P1+ 展望

- embedding / ingestion 阶段 span（`vectorStore.ts`、`ingestion/`）；
- web→api trace 透传（`extractWithCozeLoopHeaders` 挂 Koa 中间件，前端带 `X-Cozeloop-Traceparent`）；
- `retrieval.trace` AG-UI CUSTOM 事件（M9-P3，前端过程展示，与 spans 数据同源）；
- 评测批跑 trace（`disableTracing` 或独立 workspace 隔离）。

## 7.1 增量（2026-10-13）：traceId 透出到前端

- api：`runManager` 在 RUN_STARTED 之后追加 `CUSTOM{name:'cozeloop.trace', value:{traceId, runId}}`（走事件日志，断线回放同样可见；禁用时不发射）；终端同步打印 traceId。
- web：chatStore 归约 `cozeloop.trace` → `Turn.traceId`；Turn 底部渲染复制芯片（mono/11px/32px 触达，点击复制完整 32 位 hex，title 悬停看全量）。
- 验证：api 新集成用例（事件顺序 + 回放，`vi.mock('@langchain-rag/rag')` 接缝 mock——api 不直接依赖 `@cozeloop/ai`，按测试文件上下文 mock 拦不住 rag 内部导入）+ web 归约 3 例；全仓 302 用例全绿；真实 run 冒烟确认 SSE 含真实 traceId。

## 7.2 增量（2026-10-13）：子代理层级 span 与 model_name 修复

真实 PAT 冒烟在罗盘 Trace 页发现两个问题（P0 设计缺口，非上报链路故障）：

1. **subagent 的 LLM 调用全部平铺在根 span 下**：deepagents 的 `task` 工具在工具体内部 `await subagent.invoke()`，工具体无法像 `search_documentation` 那样从体外包裹，`task` 执行期间没有任何 active span——回调 handler 按 ALS 取父级只能取到根 span。
2. **model span 的 model_name 显示 unknown**：`@langchain/openai` 1.x 已不再向 `llmOutput` 写 `model_name`（0.x 旧字段），handler 主来源落空；回退 `LLM_MODEL` env 未设置（默认值只存在于 `getLLM()` 代码里）→ 最终 'unknown'。**连带发现**：handler 读取的 `llmOutput.token_usage` 同为 0.x 形态，1.x 实际是流式 `generation.message.usage_metadata`（core `_streamIterator` 组装）与非流式/流式 `llmOutput.tokenUsage`（camelCase）——即 token 统计标签此前同样从未上报。

**修复**：

- 新增 `observability/subagent-span.ts`：`createSubagentSpanMiddleware()`——langchain v1 middleware（`createMiddleware` 的 `wrapToolCall` 钩子）包住主 agent 对 `task` 工具的整段执行，内部 `withCozeLoopSpan('task.<subagent_type>', tool)` 建立 active context。ALS 沿 `wrapToolCall → task 工具体 → subagent.invoke → 子代理 graph → LLM 回调` 整条 await 链传播，子代理内全部 LLM span 自动嵌套；并发多个 task 各自分叉互不串线。span input 记 `{subagent_type, description}`（截断），output 记子代理最终报告（`ToolMessage` 文本或 deepagents `Command.update.messages` 末条，截断）。`createDeepAgent({ middleware: [...] })` 接线；CozeLoop 关闭时 `withCozeLoopSpan` 直通，行为不变。
- `langchain-handler.ts` 模型名：`handleLLMStart` 从序列化 kwargs（`llm.toJSON().kwargs.model`）提取配置的模型名缓存到 run 维度，`handleLLMEnd` 按优先级上报：`kwargs.model > response_metadata.model_name（finish chunk 服务端回显，仅流式）> llmOutput.model_name（0.x）> LLM_MODEL env > 'unknown'`。
- `langchain-handler.ts` token 用量：`readTokenUsage` 逐级回退 `message.usage_metadata（1.x 标准）→ llmOutput.tokenUsage（camelCase）→ llmOutput.token_usage（0.x snake_case）`。`handleLLMError` 同步清理缓存。

**验证**：

- 离线冒烟（脚本化假模型走完整 deepagent 流程 + dummy 凭据真实 SDK + OTel 探针读 active span）：主模型 LLM 挂根 span；`task` 工具执行期间 active 为 `task.chunk-analyst`；**子代理 LLM 回调触发时 active 为 `task.span`**（修复前为根）；合成轮回到根。ALS 链路全程未断，冒烟脚本已删除不入库。
- 单测 +12：middleware 6 例 + handler model name / token 用量多形态来源 6 例（kwargs 提取、优先级、model_name 键、usage_metadata、tokenUsage、response_metadata 回显）；全仓 typecheck 0 错误、用例全绿（§8 追记：314）。
- 待用户重跑真实 query：罗盘树上子代理 LLM 应嵌套在 `task.chunk-analyst` 之下，model span 不再显示 unknown，且 token 三标签有值。

## 7.3 增量（2026-10-13）：rewrite/multiQuery model span 层级修正（并发 tool 下 ALS 断链）

用户复盘真实 trace（`39a8366d…`，53.97s）发现：3 个 `search_documentation` 工具之后平铺着 3 个 llm span，观感像"生成检索 query 的 LLM 晚于工具执行"。经 CozeLoop API 拉取全量 107 span 证伪：这些 llm 是各工具体**内部** `retrieval.transform_queries` 里 rewriteQuery 发出的调用（时间窗完整落在对应工具窗内，llm 结束时刻与其 transform_queries span 结束时刻毫秒级相等），显示顺序颠倒纯系**挂根层级 + 罗盘同层按 started_at 排序**（工具比各自 rewrite llm 早 1-6ms 启动）的观感问题。

**根因**（与 §7.2 subagent 泄漏同机理、不同路径）：本 trace 中 `task.chunk-analyst` 内层 llm 已正确嵌套（wrapToolCall 生效），泄漏的只有工具体内直调 `llm.invoke` 的 rewrite/multiQuery（10 个：批次1×4 + 批次2×6，另 2 个 rewrite 命中进程内缓存未发）。`handleLLMStart` 建 span 不带显式 parent、取回调分发瞬间的 ALS ambient；并行 tool 执行下 LangChain 实例级回调的分发续体脱离 AsyncLocalStorage store，ambient 只剩 run 根。同管线的 dense/bm25 等 traceable span 不受影响——`traceable` 在入口一次性捕获 context 并显式传给 `startActiveSpan`，ALS 只需活到 span 创建那一刻。

**修复**：绕开 ALS、改引用传递——

- `spans.ts`：新增 `cozeloopParentMetadata()`，把 `context.active()` 装进 `config.metadata`（键 `cozeloop.parent_context`）供 invoke 侧展开；`startCozeLoopSpan` 支持 `options.parent` 显式指定父级（未指定保持二参调用，行为不变）。
- `rewrite.ts` / `multiQuery.ts`：invoke config 展开 `cozeloopParentMetadata()`。
- `langchain-handler.ts`：`handleLLMStart` 第 7 参（LangChain 回传的 config.metadata，`manager.cjs` 原样透传）读取后三参 `startSpan` 显式指定父级；未携带时回退 ambient，主模型/子代理路径行为不变。

**验证**：

- 单测 +8：handler metadata 透传/回退 2 例、spans 显式 parent 与 `cozeloopParentMetadata` 2 例、transformers invoke config 透传 3 例（含禁用空对象路径）；全仓 typecheck 0 错误、**322 用例全绿**（rag 228 / web 60 / api 34）。
- 真实调用端到端：临时用例经真实 DeepSeek invoke + 真实导出（trace `55ec8551…`：run→tool→transform 三层 spanId 已记录），llm span 应挂 `e2e-transform` 之下；服务端入库有索引延迟，最终以罗盘树嵌套为准（同冒烟路径复核）。

## 7.4 增量（2026-10-14）：run 根 span output 记录最终回答

API 路径的 run 根 span output 原为 `{status, error?}`（§3.3 约定，避免序列化 ActiveRun 内部结构），最终回答只有 CLI 路径记录（`{answer}` 截断）——罗盘上看 API run 的 trace 时无法直接读到答案。对齐：`runManager.executeRun` 循环内累积 `TEXT_MESSAGE_CONTENT` delta 为 `answerText`，span 收口改写 `{status, error?, answer: truncateForSpan(answerText)}`（无回答时省略 answer 键，如流未启动即失败）。

**累积口径（首版踩坑修正）**：不能拼全部正文 delta——一次 run 里有 45 段正文（3 段主代理轮次 + 42 段 chunk-analyst 子代理报告，共 38811 字符），从头截 2000 字符全是中间产物，最终回答反而被截掉（真实 trace `c8bb863e…` 复盘确认）。最终口径：**只累积主代理（事件无 `subagentRunId`）的正文，且主代理每开一条新消息（`TEXT_MESSAGE_START`）即重置**——留下的就是最后一轮正文，即最终回答；REASONING_MESSAGE_*（思考流）本就单独成事件，天然不进。验证：api +2 用例（单轮流三键断言；多轮+子代理流断言 output 只含最终轮），全仓 324 用例全绿。

## 8. 实施回填（2026-10-13，P0 完成）

**交付**：

- 依赖：`@cozeloop/ai@0.0.11` + `axios@^1.7.1`（peer 显式化，rag 包）。
- `src/observability/` 三模块 + barrel（cozeloop.ts / spans.ts / langchain-handler.ts）；`@langchain-rag/rag` 主 barrel 导出公共 API，api 包经此使用、不直接依赖 SDK。
- libs `getLLM({ callbacks? })`：实例级回调注入（捕获工具内部 rewrite/multiQuery 的 LLM 调用）。
- 埋点：api `RunManager.execute` 根 span（baggage thread_id/run_id，`setSpanOutput` 终态收口）、CLI 每问根 span；检索管线 `retrieval` + `transform_queries`/`dense`/`bm25`/`rerank`/`mmr` 阶段 span；`search_documentation` tool span；弃答闸门 `retrieval.gate` 决策 span（decision/best_rerank_score/max_dense_score/top_doc_path）。
- 退出安全：api 优雅停机（`waitIdle` 后）与 CLI finally 均 `shutdownCozeLoop()`；`COZELOOP_*` 补入 `.env.example`。
- 与初稿偏差：见 §3.3 尾注（bm25+fusion 合并、gate 与 retrieval 同级）；`COZELOOP_ENABLED=true` 缺凭据从「交由 SDK 报错」改为 init 时 fail-fast 抛配置错误（更早、更可定位）。

**验证**：

- `pnpm typecheck` 递归 0 错误；`pnpm test` **298 全绿**（rag 208 / api 33 / web 57），其中 observability 新增 **33 例**（cozeloop gate/幂等/关停 11、spans 包装/脱敏/手动生命周期 12、LLM 回调生命周期/token/TTFT/run_id 幂等 10），全部 `vi.mock('@cozeloop/ai')`，不触真实服务。
- tsx 冒烟：无 env 时 init 返回 false、callbacks 为空数组、`withCozeLoopSpan` 直通 `fn(null)`、真实 SDK 在 ESM/tsx 下可正常加载（SpanKind/tracer 接口核对无误）；禁用路径 shutdown 零 SDK 调用（冒烟发现的 `initialized` 语义 bug，已修并有单测锁定）。
- **待用户执行的真实验收**：[loop.coze.cn](https://loop.coze.cn) 控制台建 workspace + 个人访问令牌 → 填入 `packages/rag/.env`（`COZELOOP_API_TOKEN`/`COZELOOP_WORKSPACE_ID`）→ `pnpm serve` 问一轮、`pnpm rag` 单问 → 罗盘 Trace 页核对：span 树层级（run→llm/tool→retrieval→stages）、model span 的 token 统计与 TTFT、gate 决策；去掉 token 复验 no-op 无报错。

**追记（2026-10-13，§7.2 后）**：真实 PAT 冒烟暴露 subagent 层级缺失、model_name unknown 与 token 用量不上报三个问题，已修复（见 §7.2）；全仓用例 314（rag 220 / api 34 / web 60）全绿，typecheck 0 错误。
