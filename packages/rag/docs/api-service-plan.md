# API 服务化改造（Koa + AG-UI + 断线续传）技术方案

> 状态：**实施中（2026-10-10）**——P0 基座、P1 AG-UI 事件流、P2 持久化与断线续传已完成（见 §11 与 Milestone M9），P3 待实施；实施后按惯例回填结果与本文件状态。
> 范围：仅后端 RAG 服务改造与前端对接契约；前端界面另行设计（分支 `feat/frontend`）。

## 1. 背景与目标

当前 agent 只能通过本地 CLI 交互（`pnpm rag`）：`agent.ts` 单次问答、进程内流式打印、退出即丢状态。要支撑 Web 前端交互，需要：

1. **API 服务化**：以 Koa.js 封装 RAG agent，问答通过 HTTP 接口触发；
2. **AG-UI 协议**：agent 内部事件（流式回答、工具调用、子代理进度）以 [AG-UI 协议](https://docs.ag-ui.com)（Agent-User Interaction Protocol，CopilotKit 发起的事件协议标准）暴露给前端；
3. **断点续传**：前端刷新/断线不影响服务端正在执行的 run；重连后可恢复历史并继续接收事件流 ⇒ 事件与状态必须持久化（本方案选 **Redis**）。

### 非目标（v1 明确不做）

- 不做多用户认证/权限体系（单机自用，预留 `RAG_API_CORS_ORIGINS` 与鉴权中间件挂载点）；
- 不做多实例水平扩展（RunManager 单进程内管理，扩展路径见 §8.6）；
- 不做**崩溃后续跑**（进程重启后 in-flight run 标记失败并告知前端；从 LangGraph checkpoint 恢复中断执行属 durable execution 范畴，列为后续方向 §12）；
- 不改检索/切分策略——本方案不触碰检索管线与评测基线，无需 A/B（纪律见 AGENTS.md）。

## 2. 现状盘点与复用点

| 现状 | 服务化后的处置 |
|---|---|
| `createRagAgent()`（`retrieval/index.ts`）组装 deepagents agent（`search_documentation` 工具 + `chunk-analyst` 子代理 + `StateBackend`） | **原样复用**，新增 `checkpointer` 参数（deepagents `CreateDeepAgentParams.checkpointer?: BaseCheckpointSaver`，v1.12.2 已支持），CLI 路径不传保持行为不变 |
| `createRagAgent` 当前无包导出（`main` 指 `agent.ts`，跨包无法 import） | rag 新增 `src/index.ts` barrel + `exports` 字段（§9.2），api 包以 `workspace:*` 消费 |
| CLI 用 `agent.streamEvents(state, {version:'v3'})`，`run.messages` 提供消息生命周期流（流式 `.text`/`.reasoning`），子代理流经 `run.extensions` 暴露 | 服务端同一 API 消费，翻译为 AG-UI 事件（§6） |
| agent 状态（messages、`/retrieved/` 文件、todos）在 `StateBackend`/图状态内，随进程销毁 | 引入 LangGraph Redis checkpointer 按 `thread_id` 持久化 |
| `buildVectorStore()` + BM25 热启动在每次 CLI 启动执行（秒级） | 服务启动时构建一次，进程内单例（§8.1） |
| 检索参数全部走 `RETRIEVAL_*` env → `config.ts` | 延续同一模式，新增服务配置节（§9.1） |

依赖兼容性已核实：`@langchain/langgraph-checkpoint-redis@1.0.12`（peer `@langchain/core ^1.1.48`，与本项目 core 1.2.5 兼容）；`@ag-ui/core` / `@ag-ui/encoder` @ `^1.0.2`。

## 3. 总体架构

核心决策：**run 的执行与 SSE 连接解耦**。run 由进程内 RunManager 驱动，事件先落 Redis Stream（append-only 事件日志），SSE 连接只是日志的消费者（可随时断开、重连、回放）。

```
┌────────────────────── Node 进程（packages/api · @langchain-rag/api）──────────────┐
│                                                                                │
│  Koa (HTTP/SSE)                                                                │
│   ├─ POST /agui                      ── AG-UI 标准端点（HttpAgent 直接可用）    │
│   ├─ GET  /threads/:id/events        ── 断线续传端点（回放 + 实时尾随）          │
│   ├─ REST  /threads /runs/:id/cancel ── 会话管理                                │
│   └─ GET  /health /ready                                                       │
│         │                                                                      │
│  RunManager（每 thread 同时至多 1 个活跃 run）                                  │
│   ├─ AgUiTranslator：deepagents streamEvents v3 → AG-UI 事件                    │
│   ├─ deepagents agent 单例（复用 packages/rag 的 createRagAgent + checkpointer）│
│   └─ 事件扇出：内存订阅者（活跃 SSE）+ XAPPEND Redis Stream                     │
│                                                                                │
└──────────────┬─────────────────────────────────────────────┬───────────────────┘
               │                                             │
        ┌──────▼──────┐                               ┌──────▼──────────┐
        │   Qdrant    │                               │  Redis          │
        │ （向量+BM25  │                               │  ├ Stream：事件日志（断线回放）
        │  语料元数据） │                               │  ├ Hash：thread/run 元数据
        └─────────────┘                               │  └ LangGraph checkpoints（消息/文件/todos）
                                                      └─────────────────┘
```

前端两通道、单一事实源：

- **写通道**：`POST /agui` 触发 run（AG-UI v1.0 SSE binding，事件同时写入 Redis Stream）；
- **读通道**：`GET /threads/:id/events` 按游标回放 + 实时尾随。**页面刷新后的恢复走这条**，与是否有活跃 run 无关。

## 4. 技术选型与决策记录

| # | 决策 | 理由 | 被否方案 |
|---|---|---|---|
| D1 | 事件协议用 AG-UI v1.0（16 类标准事件 + subagent 扩展），TS 侧只依赖 `@ag-ui/core`（类型+zod schema）与 `@ag-ui/encoder`（SSE 帧） | 协议标准、事件模型与 deepagents 形态高度对齐（`SubagentStarted/Finished` 恰好映射 chunk-analyst）；前端可用 `@ag-ui/client` 的 `HttpAgent` 开箱对接 | 自定义事件 JSON schema（前端成本高、无生态） |
| D2 | deepagents → AG-UI 翻译层**自研**（薄层，纯函数） | `@ag-ui/langchain` 尚在 0.0.3，面向 LangChain 0.x 的 streamEvents v2 + rxjs，不支持 deepagents v3 流（无子代理事件）；自研层 <200 行且可测 | 引入 `@ag-ui/langchain`（版本风险）；上 LangGraph Server（新增部署依赖，违背轻量自托管诉求） |
| D3 | 持久化选 **Redis**：事件日志用 Redis Stream，元数据用 Hash，agent 状态用 `@langchain/langgraph-checkpoint-redis` | Stream 天然 append-only + 按 id 区间回放（`XRANGE`）+ 尾随（`XREAD BLOCK`），与断线续传需求一一对应；checkpointer 官方包与现有 LangChain 1.x 栈兼容；infra 已 docker 化，加一个服务即可 | Postgres（无关系查询诉求，事件热读写模式不匹配；若日后要长期审计可加导出，见 §12）；纯内存（刷新即丢 run，不满足需求 3） |
| D4 | SSE 传输（Koa 原生流式响应），不引入 WebSocket | AG-UI 默认绑定即 SSE（POST → `text/event-stream`）；通信是单向服务端推送；Koa 无需额外依赖 | WebSocket（协议未定义该绑定；双向能力闲置） |
| D5 | 断线恢复不依赖 AG-UI 传输层（v1.0 明确 SSE 不用 `Last-Event-ID`、断流不可重入），由**服务端事件日志 + 自有 attach 端点**实现 | 规范原文：恢复 = 新 run；serialization 章节给出的正解是服务端持久化事件流、客户端重放。我们的 `GET /threads/:id/events` 是规范之上的自有扩展，标准 `POST /agui` 保持 100% 合规 | 在 `POST /agui` 上塞 resume 语义（污染标准端点） |
| D6 | run 生命周期归 RunManager，**客户端断开 ≠ 取消**（取消必须显式调 cancel 端点） | 需求 3 的本质：浏览器刷新断开 SSE 时 run 必须继续跑完并落日志 | 连接断开即取消 run（刷新即中断，违背需求） |
| D7 | 服务层拆**独立包** `packages/api`（`@langchain-rag/api`），`packages/rag` 保持纯基座（agent/检索/切分/评测），依赖单向 `api → rag`（`workspace:*` + rag `exports` 直指 TS 源，no-build，与 libs `main: llm-provider.ts` 同一模式的规范化） | 职责分离：HTTP/服务化依赖（koa、@ag-ui/*、ioredis、checkpointer-redis）不渗透进检索/评测包；rag 继续独立支撑 CLI 与评测，评测依赖面零变化 | 服务代码内嵌 `packages/rag/src/server/`（少一个包，但 rag 职责混杂、依赖面扩大，违背本次拆分诉求） |

## 5. API 契约（前端对接面）

约定：所有响应 `application/json`（SSE 端点除外）；错误体统一 `{"error": {"code": string, "message": string}}`；id 均为 UUIDv4。Base URL 开发期 `http://localhost:3000`。

### 5.1 `POST /agui` — AG-UI 标准运行端点

AG-UI v1.0 HTTP+SSE binding：请求体 `RunAgentInput`，响应 `text/event-stream`。`@ag-ui/client` 的 `HttpAgent({url: base + '/agui'})` 无需适配直接可用。

请求体（本项目实际消费的字段）：

| 字段 | 类型 | 服务端行为 |
|---|---|---|
| `threadId` | string | 必填（客户端用 `crypto.randomUUID()` 生成，或先经 `POST /threads` 创建拿回）。首次出现的 thread 自动建档 |
| `runId` | string | 必填，客户端生成。重复 runId 幂等返回 409 |
| `messages` | Message[] | 只取**最后一条 user 消息**作为本次输入；历史以服务端 checkpointer 为准（冲突策略：服务端状态优先，见 §7.3） |
| `state` / `tools` / `context` / `capabilities` / `forwardProps` | — | v1 忽略（不向前端开放工具注册），`forwardProps` 预留透传 trace 开关 |

流内事件序列（§6 详表）：`RUN_STARTED` → 消息/工具/子代理事件… → `RUN_FINISHED`（或 `RUN_ERROR`）。流前错误（校验/限流/同 thread 已有活跃 run）返回 HTTP 4xx/5xx，不开流。

本端点特有约束：

- **同 thread 同时只允许一个活跃 run**：活跃时 POST 返回 `409 {"error":{"code":"run_already_active","runId":"<活跃runId>"}}`，前端应改走 §5.3 附流；
- 进程级并发闸门 `RAG_MAX_CONCURRENT_RUNS`（默认 4，防 DashScope TPM 限流，见 §8.4）：超限返回 `429` + `Retry-After`；
- 每帧 `data:` 为**恰好一个** AG-UI 事件 JSON（规范要求）；SSE `id:` 字段写入事件日志游标（见 §5.3），标准客户端会忽略，`EventSource` 类客户端可借此自动重连。

### 5.2 会话管理 REST

| 方法 & 路径 | 说明 | 响应示例 |
|---|---|---|
| `POST /threads` | 显式建会话（`{title?}`，title 缺省在首问后回填为问题摘要） | `201 {"threadId":"…","title":null,"createdAt":"…","updatedAt":"…"}` |
| `GET /threads?cursor=&limit=20` | 按 `updatedAt` 倒序列出会话 | `{"items":[{threadId,title,updatedAt,activeRun:{runId,status}|null}],"nextCursor":null}` |
| `GET /threads/:threadId` | 会话详情 + 活跃 run 状态 + 最新事件游标 `lastEventId` | `{"threadId":"…","title":"…","activeRun":null,"lastEventId":"1728-1","messageCount":12}` |
| `GET /threads/:threadId/messages` | 压缩后的历史消息（服务端用 AG-UI `compactEvents` 语义把事件日志折叠为 `MESSAGES_SNAPSHOT`），前端首屏渲染用，**替代**一次性拉全量事件 | `{"messages":[{id,role,content}…]}` |
| `POST /threads/:threadId/runs/:runId/cancel` | 取消活跃 run（幂等；run 已结束返回 200 + 终态） | `{"runId":"…","status":"cancelling"}` |
| `DELETE /threads/:threadId` | 删除会话（事件日志 + 元数据 + checkpoints） | `204`（P2 交付） |

### 5.3 `GET /threads/:threadId/events` — 断线续传端点（自有扩展）

页面加载/刷新时的**唯一恢复入口**，SSE 响应：

```
GET /threads/:threadId/events?afterEventId=<可选游标>
```

| 参数 | 说明 |
|---|---|
| `afterEventId` | 上次收到的日志游标（Redis Stream entry id，形如 `1728541234567-3`；也可经 `Last-Event-ID` 请求头传入）。缺省 = 仅实时尾随不回放；`afterEventId=0` = 从头全量回放 |

行为：

1. 服务端先注册内存实时订阅（防回放期间丢新事件，按 eventId 去重）；
2. `XRANGE (afterEventId, +]` 回放已持久化事件；
3. 追上后切换为实时尾随（活跃 run 的事件经 RunManager 内存扇出直达，延迟 ~ms 级；跨实例/重启兜底轮询 Stream）；
4. 每 15s 发注释心跳 `: ka\n\n`（规范允许），连接断开只注销订阅，**不影响 run**；
5. 若回放终点 run 已终态且无活跃 run，发完即关流（HTTP 200，正常结束）。

前端刷新恢复流程：`GET /threads/:id` 拿 `lastEventId`/`activeRun` → `GET /messages` 首屏 → `GET /events?afterEventId=<本地或服务端游标>` 续流。事件按 `messageId` 聚合渲染，重复投递（POST 流与 attach 流同时开）由 eventId 去重。

### 5.4 `GET /health` / `GET /ready`

- `/health`：`{"status":"ok","version":"…","uptime":…}`（存活探针，不依赖下游）；
- `/ready`：agent 单例、Qdrant、Redis、BM25 索引就绪后 200，否则 503（K8s/部署探针与启动脚本用）。

## 6. AG-UI 事件映射（AgUiTranslator）

deepagents `streamEvents(v3)` → AG-UI 事件。事件基座字段：`type`、`timestamp`；`threadId`/`runId` 由 RunManager 注入。

| deepagents 信号 | AG-UI 事件 | 载荷要点 |
|---|---|---|
| run 启动 | `RUN_STARTED` | `threadId`, `runId` |
| 主代理 AI 消息生命周期（`run.messages` 流式 `.text`） | `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT`(delta) / `TEXT_MESSAGE_END` | `messageId` 取 LangChain message id |
| 主代理 `.reasoning` 流（链路已核实：DeepSeek `reasoning_content` → ChatOpenAI converter 解析为 thinking 块 → `.reasoning` 流；是否有内容取决于模型，见 §12 风险 1） | `REASONING_MESSAGE_START/CONTENT/END` | 同 `messageId` 关联；前端按「思考过程」折叠展示 |
| 工具调用（消费专用流 `run.toolCalls`，提供 `.input`/`.output`/`.status`）：`search_documentation`、`write_todos`、子代理委派 `task` 等 | `TOOL_CALL_START` / `TOOL_CALL_ARGS`(增量) / `TOOL_CALL_END` / `TOOL_CALL_RESULT` | `toolCallId`, `toolCallName`；args 增量流式，result 为工具返回文本（chunk 路径清单/弃答文案），检索明细走 CUSTOM（下行） |
| 子代理（chunk-analyst）启动/结束（消费 `run.subagents` 委派流） | `SubagentStarted` / `SubagentFinished` | `subagentRunId`, `name:"chunk-analyst"`, `parentToolCallId` 指向委派工具调用 |
| 子代理内部消息流 | `TEXT_MESSAGE_*`（携带 `subagentRunId` 基座字段） | 并发多个 analyst 以 `subagentRunId` 区分，前端可折叠展示"每个 chunk 的分析过程" |
| 子代理内部工具调用（`read_file` 等） | `TOOL_CALL_*`（携带 `subagentRunId`） | 与主代理工具调用同构，前端按归属分组渲染 |
| 检索管线内部信号（query rewrite 结果、dense/BM25 候选数、rerank 闸门判定、命中 chunk 明细） | `CUSTOM` | `name:"retrieval.trace"`, `value` 结构见下 |
| run 正常结束 | `RUN_FINISHED` + 收尾 `MESSAGES_SNAPSHOT` | snapshot 便于刷新后 `GET /messages` 与日志自校验 |
| run 异常/超时/取消/进程重启 | `RUN_ERROR` | `message`，`code`：`timeout` / `cancelled` / `server_error` / `server_restart` |

`retrieval.trace` CUSTOM 事件（对应现在 `🚪 Gate:` 等 console 日志的服务化形态，用 AsyncLocalStorage 按_run_收集，开关 `RETRIEVAL_TRACE_EVENTS`，默认开）：

```json
{ "type": "CUSTOM", "name": "retrieval.trace", "timestamp": 0,
  "value": {
    "stage": "gate",
    "query": "什么是langchain",
    "rewrittenQuery": "LangChain 概念与核心组件介绍",
    "candidates": 20, "topK": 4,
    "gate": { "signal": "rerank", "score": 0.8312, "threshold": 0.52, "decision": "PASS" },
    "chunks": [
      { "path": "/retrieved/a1b2c3d4/chunk_1.md",
        "source": "https://docs.langchain.com/oss/javascript/langchain/overview",
        "sectionPath": ["Introduction"], "score": 0.8312, "rerankScore": 0.8312 } ] } }
```

`chunks` 为本次 topK 命中明细（`source`/`sectionPath`/融合 `score`/`rerankScore`，字段与 `ScoredChunk` 元数据同源），支撑前端「引用来源/命中详情」面板；弃答分支无 `chunks`、仅 `gate.decision:"ABSTAIN"`。

一次典型问答的事件序列（节选）：

```
RUN_STARTED
├ TEXT_MESSAGE_START (主代理开始输出)          ← 规划阶段
│ ├ TEXT_MESSAGE_CONTENT × n
│ └ TEXT_MESSAGE_END
├ TOOL_CALL_START/ARGS/END (search_documentation)
│ ├ CUSTOM retrieval.trace (gate PASS, 4 chunks)
│ └ TOOL_CALL_RESULT
├ SubagentStarted (chunk-analyst ×3, 携 subagentRunId)
│ ├ TOOL_CALL_* (read_file, 携 subagentRunId)
│ ├ TEXT_MESSAGE_* (subagentRunId …)
│ └ SubagentFinished ×3
├ TOOL_CALL_* (write_todos / 后续 search …)
├ TEXT_MESSAGE_* (最终答案, 含引用)
├ RUN_FINISHED
└ MESSAGES_SNAPSHOT
```

> 实现注记（P1 已实测确认，2026-10-10，探针 `packages/api/scripts/probe-v3-stream.ts`）：消费 `run` 的**单一全局有序 ProtocolEvent 流**（比分别迭代 `run.messages`/`run.toolCalls`/`run.subagents` 三个投影更能保证跨类事件顺序）。归属规则：ns `model_request:*`（深度 1）= 主代理；ns `tools:X/model_request:Y`（深度 ≥2）= 子代理（subagentRunId=X）；ns `tools:X`（深度 1）= 工具内部 LLM（query rewrite，不映射，P3 转 retrieval.trace）。`deepseek-v4-flash` 确认输出 reasoning（reasoning-delta 块）。两个实测坑：① `tool-finished` 无 `tool_name` 字段（普通工具 name 在 `output.name`）；② task（子代理委派）的 output 是 LangGraph **Command**（内容在 `update.messages` 末条 ToolMessage），非普通 ToolMessage。

## 7. 持久化设计

### 7.1 Redis 数据模型

| Key | 类型 | 内容 | TTL |
|---|---|---|---|
| `rag:thread:{threadId}:events` | Stream | 整个 thread 的 AG-UI 事件日志；entry id 即事件游标，field `e` = 事件 JSON | `THREAD_TTL_HOURS`（默认 720h/30d，每次写刷新） |
| `rag:thread:{threadId}:meta` | Hash | `title`, `createdAt`, `updatedAt`, `lastEventId`, `messageCount` | 同上 |
| `rag:run:{runId}` | String(JSON) | `threadId`, `status`(running/finished/error/cancelled/interrupted), `startedAt/endedAt`, `error`, TTL 24h | 短（诊断用） |
| `rag:index:threads` | ZSet | `threadId` 按 `updatedAt` 排序，支撑会话列表分页 | 随 thread 删除清理 |
| checkpoints（由 checkpointer 包管理） | — | LangGraph 图状态：messages、`/retrieved/` 文件、todos，按 `thread_id` | 由 checkpointer 配置，对齐 thread TTL |

客户端选型：自建事件存储用 `ioredis@^6`；checkpointer 包自带 `redis@^4` 客户端（其内部依赖，不与我们共享连接）。两客户端并存可接受，避免为共享连接 fork 该包。

### 7.2 断线续传正确性

- **单写者**：每 thread 同时只有一个 run（§5.1 约束），Stream 内事件天然全序，游标即进度；
- **回放/实时衔接**：先订阅后回放，按 entry id 去重（§5.3 步骤 1），不存在丢事件窗口；
- **刷新场景**：run 继续 → 事件持续 XADD → 前端重连从游标补齐；
- **溢出保护**：`MAXMEN` 不设（有 TTL），但 `RAG_MAX_EVENTS_PER_THREAD`（默认 10k）超限时对旧事件做压缩折叠（`compactEvents` 语义：TEXT_* 流 → MESSAGES_SNAPSHOT）后 `XDEL` 原始帧，P3 实现。

### 7.3 LangGraph checkpointer（会话连续性）

`createDeepAgent({..., checkpointer: await RedisSaver.fromUrl(REDIS_URL, {defaultTTL: THREAD_TTL_MINUTES})})`（`@langchain/langgraph-checkpoint-redis`；无需时间回溯则选 `ShallowRedisSaver`——每 thread 只留最新 checkpoint，更省内存，P2 二选一），每次 invoke/streamEvents 传 `configurable.thread_id = threadId`：

- 同 thread 多轮对话：历史 messages、已检索文件、todos 自动恢复，前端只需发增量 user 消息；
- `POST /agui` 的 `messages` 只取最后一条 user 消息正源于此；**冲突策略：服务端状态优先**（前端传入的历史仅作渲染参考，不回写）；
- 删除 thread 时需同时清 checkpoints key（checkpointer 的 key 规则在其文档确认，P2 落实）。

### 7.4 进程重启语义

启动时扫描 `rag:run:*` 中 `status=running` 的记录 → 置 `interrupted`，并向对应 thread Stream 追加 `RUN_ERROR{code:"server_restart"}`（幂等：写标记前先抢 `rag:run:{runId}:finalized` SETNX）。历史事件与 checkpoints 不受影响，前端刷新后看到「该轮中断」并可直接发起新 run。**不做**从 checkpoint 续跑中断 run（见 §1 非目标）。

## 8. 运行时行为（RunManager）

### 8.1 agent 单例与启动

- 启动即 `createRagAgent({checkpointer})`：构建 Qdrant 连接、BM25 热启动（秒级）一次完成，`/ready` 通过后放行流量；未就绪时 `POST /agui` 返回 `503`；
- 已知约束：DashScope embedding 有 ~10万 tokens/分钟 TPM 限流（历史经验：rebuild 必撞，表象为 insufficient_quota），启动期 BM25 重建若撞限流按既有 maxRetries 退避，不阻塞 HTTP 绑定（ready 检查可区分「BM25 未就绪，降级纯 dense」——v1 简化为不就绪即 503，是否降级留开放问题 §12）。

### 8.2 run 生命周期

```
queued → running → finished | error | cancelled | interrupted(进程重启标记)
```

`streamEvents` 的异步迭代驱动整个状态机：事件逐条 → (a) XADD Stream (b) 扇出给活跃 SSE 订阅者。迭代正常结束 `finished`；抛错 `error`；显式 cancel 触发 AbortController → `cancelled`；`RAG_RUN_TIMEOUT_MS`（默认 300s）到点强制 abort → `error{code:timeout}`。

### 8.3 取消

`POST /threads/:id/runs/:runId/cancel` → RunManager 以 runId 路由到执行中的 async 迭代，调用其 AbortController。**注意**：`HttpAgent.abortRun()` 只断 fetch，不触发服务端取消——前端语义上「关掉事件流」与「停止生成」是两个动作，后者必须显式调本端点（写入前端对接文档）。

### 8.4 并发与背压

- 进程级 `RAG_MAX_CONCURRENT_RUNS`（默认 4）信号量，超限 429 + Retry-After（embedding/rerank TPM 是瓶颈，run 内子代理并发已有 `maxConcurrentAnalysts=3` 上限）；
- 每 thread 串行（§5.1），thread 之间并行；
- SSE 订阅者消费过慢：每连接 ≥1MB 缓冲，满则断开该连接（可无损重连回放），不反压 run。

### 8.5 优雅停机

SIGTERM → 停止接受新 run（`POST /agui` 返回 503）→ 等待活跃 run 至多 `GRACEFUL_SHUTDOWN_MS`（默认 30s）→ 超时的 run 标记 `interrupted` 并写 `RUN_ERROR{server_restart}` → 关 HTTP → 退出。（部署重启窗口内前端经 §5.3 恢复可见终态。）

### 8.6 多实例扩展路径（非 v1）

事件已在 Redis，任一实例都能服务 `GET /events` 回放；需要做的仅是：run 调度集中化（如按 thread 哈希分片或 Redis 队列派工）与取消命令跨实例投递（pub/sub `rag:run:{runId}:control`）。v1 单实例，接口契约按可扩展设计（runId 全局路由键）。

## 9. 配置与部署

### 9.1 新增环境变量（记入 `packages/api/.env.example`「API Server」节）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听 |
| `REDIS_URL` | `redis://localhost:6379` | 事件日志/元数据/checkpoint |
| `RAG_API_CORS_ORIGINS` | `http://localhost:5173` | 逗号分隔白名单；`*` 关闭校验（仅开发） |
| `RAG_MAX_CONCURRENT_RUNS` | `4` | 进程级 run 并发闸门 |
| `RAG_RUN_TIMEOUT_MS` | `300000` | 单 run 上限 |
| `THREAD_TTL_HOURS` | `720` | 事件日志与会话元数据保留期 |
| `SSE_HEARTBEAT_MS` | `15000` | SSE 注释心跳 |
| `RETRIEVAL_TRACE_EVENTS` | `true` | retrieval.trace CUSTOM 事件开关 |

### 9.2 包结构与依赖（决策 D7）

**职责边界**：`packages/rag`（`docs-rag-agent`）保持 agent/检索/切分/评测基座，不引入任何 HTTP 依赖；新增 `packages/api`（`@langchain-rag/api`）承载服务外壳，依赖单向 `api → rag`。

```
packages/api/                        # @langchain-rag/api（新包）
  src/
    index.ts                         启动：Koa app + agent 单例 + 优雅停机
    config.ts                        服务配置（§9.1）
    routes/                          agui.ts / threads.ts / health.ts
    runManager.ts                    run 状态机、信号量、取消、扇出
    translator.ts                    deepagents → AG-UI（纯函数）
    persistence/                     eventStore.ts（Stream 读写/压缩）/ threadStore.ts / checkpointer.ts
    sse.ts                           SSE 帧封装（EventEncoder）、心跳、订阅管理
    __tests__/                       golden 序列、store、路由集成测试
  package.json                       deps：koa@^3、@koa/router@^15、@ag-ui/core@^1、
                                     @ag-ui/encoder@^1、ioredis@^6、
                                     @langchain/langgraph-checkpoint-redis@^1、
                                     docs-rag-agent(workspace:*)
                                     devDeps：tsx、typescript、vitest、@types/node
  .env.example                       API Server 段（§9.1）；检索/LLM 段经级联加载复用 rag 现有配置
  tsconfig.json                      与 rag 同构（ESM + moduleResolution: bundler + noEmit）
```

- **rag 侧最小改动**（仅两处）：新增 `src/index.ts` barrel（导出 `createRagAgent`、`getRetrievalConfig`），`package.json` 增 `"exports": { ".": "./src/index.ts" }`——no-build 直指 TS 源，与 libs `main: llm-provider.ts` 同一模式的规范化；`createRagAgent` 增可选 `checkpointer` 参数（默认 undefined，CLI 行为零变化）。CLI 入口 `agent.ts`、evals 均不动；
- **跨包装配**：`docs-rag-agent: workspace:*` 经 pnpm 符号链接解析到 rag TS 源，tsx 运行时直接执行、tsc `bundler` 解析可类型检查；rag 的传递依赖（deepagents、@langchain/*）从 `packages/rag/node_modules` 就近解析，无需在 api 重复声明；
- **env 级联加载**：api 启动先加载自身 `.env`，再以不覆盖（override: false）方式加载 `../rag/.env` 补齐 LLM/Embedding/Qdrant/Retrieval 配置——现有 `.env` 不搬家，新增服务变量就近放 `packages/api/.env`；
- **脚本**：api 增 `"serve": "tsx src/index.ts"`、`"typecheck"`、`"test"`；根 package.json 增 `"serve": "pnpm --filter @langchain-rag/api run serve"`（`pnpm typecheck`/`pnpm test` 根脚本本就递归，自然覆盖新包）；
- **基础设施**：`docker-compose.yml` 仍在 `packages/rag`（共享数据设施定位不变），追加 **`redis:8-alpine`**（`6379`；≥8 为硬约束——checkpointer 依赖 RedisJSON；AOF 关闭——缓存语义，TTL 管生命周期）；
- **同步维护**：AGENTS.md 包表与常用命令、根 README（P0 一并更新）；本方案文档按 AGENTS.md 惯例继续留在 `packages/rag/docs/`。

## 10. 测试与验收

| 层 | 内容 |
|---|---|
| 单测（纯函数） | translator golden 序列：伪造 deepagents 消息流 → 断言 AG-UI 事件序列逐条相等；SSE 帧编码（EventEncoder 输出）；compactEvents 压缩正确性；Redis key/TTL 组装 |
| 集成（真 Redis，docker） | eventStore XADD/XRANGE/衔接去重；断连重放不丢不重（并发写 + 断续读）；checkpointer 跨实例恢复 thread 状态 |
| HTTP 集成 | 临时端口拉起 Koa：`POST /agui` mock agent 全序列；409/429/503 分支；cancel 幂等；SSE 心跳与客户端断开不杀 run（断言 run 终态 finished） |
| 端到端冒烟 | `make infra-up && pnpm serve` → curl POST /agui 观察完整事件流；中途断开重连 `GET /events` 补齐；重启服务验证 §7.4 |
| 回归 | `pnpm typecheck && pnpm test` 全绿（根脚本递归，含新 api 包）；`pnpm rag` CLI 行为不变；检索路径未动，评测基线无需重跑 |

验收标准（对应三条需求）：HttpAgent/Curl 可完成一次带完整 AG-UI 事件的问答；run 进行中刷新（断开全部 SSE）→ run 正常 finished 且重连可回放全部事件；重启进程 → 中断被明确标记、历史会话与新轮次可继续。

## 11. 实施计划（里程碑 M9，实施时同步登记 Milestone.md）

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| P0 基座 ✅（2026-10-10） | 脚手架 `packages/api`（package.json / tsconfig / vitest / .env.example）、rag 增库导出（barrel + exports）与 `checkpointer` 参数（暂不启用）、compose 加 redis、Koa 骨架 + health/ready、agent 单例服务化；同步 AGENTS.md 包表与根 README | `/ready` 200，CLI 回归不变，根递归 typecheck/test 覆盖新包 —— **已达成**（185 测试全绿：rag 175 + api 10） |
| P1 AG-UI 事件流 ✅（2026-10-10） | translator、RunManager（内存扇出，暂不持久化）、`POST /agui` + SSE、cancel 端点 | curl 全事件序列冒烟通过 —— **已达成**（真实问答：RUN_STARTED → REASONING 流（deepseek-v4-flash 确认输出 reasoning_content）→ TEXT 流 → 流式 TOOL_CALL → SUBAGENT_STARTED/FINISHED 配对 → MESSAGES_SNAPSHOT → RUN_FINISHED；断开 SSE 后 run 存活（409 验证）、cancel 收流 RUN_ERROR{code:cancelled}） |
| P2 持久化与续传 ✅（2026-10-10） | Redis eventStore + checkpointer、threads REST、`GET /events` 回放尾随、重启语义 | 验收 2/3 两条通过 —— **已达成**：①刷新——run 进行中断开 SSE（已收 1729 事件）→ `GET /events?afterEventId=0` 回放前缀+实时尾随至 RUN_FINISHED，id 帧零重复；②两轮对话——第二轮准确复述首问（checkpointer 历史恢复），第一轮 `/retrieved/` 文件第二轮仍可访问（§12 风险 3 闭环）；③重启——kill -9 后重启，run 置 interrupted 并补发 `RUN_ERROR{server_restart}`，同 thread 新 run 可继续。**实施发现：langgraph-checkpoint-redis 依赖 RedisJSON（JSON.GET/SET），Redis 必须 ≥ 8（开源版内置 JSON 模块），compose 已从 7-alpine 升级** |
| P3 加固与打磨 | cancel/超时/信号量/CORS、trace CUSTOM 事件、日志压缩、测试补齐、文档回填 + Milestone M9 登记 | §10 全表绿 |

依赖关系串行；P1 结束即可给前端提供可联调的 mock 契约（本文件 §5/§6 即契约源）。

## 12. 风险与开放问题

| # | 风险/问题 | 处置 |
|---|---|---|
| 1 | deepagents v3 流的确切事件形状与文档表述有出入（`.reasoning`、子代理流挂载点）；且 `deepseek-v4-flash` 是否输出 `reasoning_content` 未验证——协议与解析链路已就绪，但模型不输出则 `REASONING_*` 事件为空（前端以 `write_todos` + 主代理文本流近似呈现规划过程） | P1 首日用最小脚本实测确认两者，translator 隔离在纯函数层，变更不影响契约 |
| 2 | DashScope TPM 限流在并发 run 下放大（多 run 各自 embedding/rewrite） | 并发闸门 4 + 既有 maxRetries；上线后观察 429，必要时降到 2 或引入 run 排队 |
| 3 | StateBackend 与 checkpointer 组合下 `/retrieved/` 文件跨轮恢复行为未实测 | **P2 已实测闭环（2026-10-10）**：跨轮对话中第二轮可 ls/读取第一轮的 `/retrieved/` 目录与文件 |
| 4 | Redis 成为新单点（宕机 = 无法问答） | v1 接受（本地 compose，restart: unless-stopped）；事件日志有 TTL 自愈，checkpoints 丢失仅丢会话历史 |
| 5 | 开放：BM25 未就绪时是否降级纯 dense 而非 503 | 倾向 v1 不降级（检索行为一致性优先），有诉求再开开关 |
| 6 | 开放：长会话事件日志膨胀 | P3 的压缩折叠（§7.2）+ TTL 兜底；更长期可导出 PG/对象存储做审计 |
| 7 | 开放：鉴权方案（token / 无） | 单机自用暂不做；中间件挂载点已预留，上公网前必须补 |

## 附：与 AG-UI 规范的符合性声明

- `POST /agui` 严格遵循 [HTTP+SSE binding v1.0]：POST JSON → 200 + `text/event-stream`；每 `data:` 帧一个事件；终端事件后关流；流前错误用 HTTP 状态码；注释心跳。
- `GET /threads/:id/events` 及全部 REST 为**规范外自有扩展**（服务于断点续传；规范明言传输层不提供重入，恢复属服务端持久化职责）。
- 使用 `SubagentStarted/Finished`、`REASONING_*` 等 v1.0 事件；`id:`/`Last-Event-ID` 的使用为传输层增强，标准客户端按规范忽略未知字段，不破坏互操作。
