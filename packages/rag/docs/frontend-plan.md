# 前端问答界面（React + Vite）设计方案

> 状态：**已完成（2026-10-10）**——`packages/web`（`@langchain-rag/web`）已实施并通过浏览器联调验收（§9 回填）；分支 `feat/frontend`。
> 范围：`packages/web`（`@langchain-rag/web`）子包：基础问答交互 + 断线续传恢复；对接契约以 `api-service-plan.md` §5/§6 为准（本文摘要并标注以代码核实的事实）。
> 非目标：鉴权/多用户、移动端适配打磨、retrieval.trace 引用面板的完整形态（依赖 M9-P3，先做优雅降级）、生产部署形态（开发期 Vite dev server + CORS 直连 `localhost:3000`）。

## 1. 背景与目标

M9-P0~P2 已交付完整后端：`POST /agui`（AG-UI v1.0 SSE）、`GET /threads/:id/events`（事件日志回放 + 尾随）、threads REST、Redis 持久化。前端需要：

1. **基础问答**：多会话管理；流式渲染思考过程（reasoning）、工具调用、子代理（chunk-analyst）进度、Markdown 最终答案；
2. **断线续传**：运行中刷新页面恢复历史并继续本轮流式；SSE 异常断开自动重连补齐；断开 ≠ 取消（停止走 cancel 端点）；
3. 明确的错误呈现：`timeout` / `server_restart` / `too_many_concurrent` 等映射为中文提示与重试入口。

## 2. 契约摘要（已对照 packages/api 实现核实）

| 事实 | 出处 |
|---|---|
| SSE 帧只有 `data:` 行（JSON 内 `type` 为 SCREAMING_SNAKE），游标为可选前置 `id:` 行（Redis Stream entry id），每 15s 注释心跳 `: ka` | `sse.ts` + `@ag-ui/encoder` |
| `POST /agui` 响应流**同样带 `id:` 游标行**——写通道断掉后可用最后游标直接走读通道续接 | `routes/agui.ts` `subscribe` 回调 |
| `GET /threads/:id/events?afterEventId=`：`0` 与缺省均为**全量回放**（文档 §5.3 的「缺省=仅尾随」未实现）；回放尾部终态且无活跃 run 则发完关流，否则尾随至 `RUN_FINISHED`/`RUN_ERROR` | `routes/threads.ts:164-185` |
| 开流前错误为 JSON：409 `run_already_active`（附活跃 runId，应转 attach）、429 `too_many_concurrent`（`Retry-After: 5`）、503 `agent_not_ready`/`persistence_unavailable`、400 `invalid_input`/`no_user_message` | `routes/agui.ts` |
| **事件流不含用户消息**：用户提问只出现在 `MESSAGES_SNAPSHOT`（每轮 run 末尾发出，含全部历史）；且 snapshot 会把带 tool_calls 的 assistant 消息压平为空文本——**不能**用它替换流式渲染 | `agui/translator.ts:176-188` |
| `RUN_ERROR.code ∈ {timeout, cancelled, server_error, server_restart}`；cancelled 应渲染为「已停止」而非错误 | `runManager.ts` |
| `SUBAGENT_STARTED` 携带 `subagentRunId`/`name`/`parentToolCallId`（指向 task 工具调用）；子代理内部 TOOL_CALL/TEXT 事件带 `subagentRunId` | `translator.ts:345-379` |
| `GET /threads` 列表的 `nextCursor` 是 offset 整数（非事件游标），两者勿混淆 | `routes/threads.ts:47-64` |
| `CUSTOM retrieval.trace`（引用/弃答信号）为 M9-P3 项，当前不发射——前端先做类型与渲染占位 | plan §6 |

## 3. 总体架构

```
┌─ 浏览器（packages/web · @langchain-rag/web · Vite dev :5173）──────────────┐
│                                                                            │
│  React 组件树                     ThreadController（每打开线程一个）        │
│   ├ Sidebar（会话列表/删除）  ←─┐   ├ send(text)：POST /agui（乐观 Turn）   │
│   ├ ChatView（Turn 列表）   ←─┤   ├ attach(after)：GET /events 全量回放   │
│   └ Composer（发送/停止）   ←─┤   ├ 断线退避重连（1s→2s→…≤15s）            │
│          ↑ useReducer         │   ├ 409 run_already_active → 转 attach     │
│   chatStore：applyEvents()    │   └ cancel() → POST …/runs/:id/cancel      │
│   （纯函数事件归约，幂等去重）  │                                           │
│                    ↑ 批量 dispatch {eventId, event}[]                      │
│              lib/sse.ts：fetch-SSE 读取器（data/id/注释行解析）             │
└────────────────────────────────────────────────────────────────────────────┘
          │ REST（lib/api.ts）                │ SSE（同源 CORS 已放行 5173）
          ▼                                  ▼
   packages/api（:3000）— Redis 事件日志（单一事实源，run 与连接解耦）
```

## 4. 技术选型与决策记录

| # | 决策 | 理由 | 被否方案 |
|---|---|---|---|
| F1 | **自研轻量 fetch-SSE 读取器（~150 行），不引入 `@ag-ui/client`** | attach 通道（`afterEventId`）、eventId 去重、409 降级、断线退避均为本项目自有扩展；HttpAgent 覆盖不了，引入反而造成 POST/GET 两套解析路径。自研读取器统一服务两通道，且规避 `HttpAgent.abortRun()` 只断流不取消的陷阱 | `@ag-ui/client` HttpAgent（无法承载恢复协议） |
| F2 | **打开线程一律 `afterEventId=0` 全量回放重建状态** | 事件日志完整有序（每 thread 单写者），回放即可还原进行中的流式文本；规避「缺省=全量」的实现歧义，也规避 mid-run 时「`GET /messages` 快照落后于 meta.lastEventId」的游标缺口。长会话优化路径（localStorage 游标 + snapshot 首屏）留待后续 | snapshot+lastEventId 增量恢复（mid-run 有缺口，需本地游标兜底，复杂度前置） |
| F3 | 状态管理零额外依赖：`useReducer` 纯函数 reducer + controller 类；hash 路由（`#/t/:threadId`）约 20 行 | 单路由单视图；贴合仓库轻依赖风格（无根 devDeps、无 turbo）；高频 delta 靠批量 dispatch + React 18 自动批处理吸收 | react-router / zustand / react-query（均为单页小应用过度设计） |
| F4 | 样式用 Tailwind CSS v4（`@tailwindcss/vite` 插件）+ 手写组件 | 仓库零样式基建，原子类快速搭聊天 UI；依赖仅两个包 | shadcn/ui（初始化重）；纯 CSS（工作量）；若 v4 插件与 Vite 8 不兼容则降级手写 CSS token，不影响其余结构 |
| F5 | `MESSAGES_SNAPSHOT` 仅用于**回填用户消息**（每轮 run 恰有一条新 user 消息），不替换渲染 | snapshot 把 tool_calls 的 assistant 压平为空文本，替换会丢工具卡片与思考结构；事件归约本身已完整还原 assistant 侧 | snapshot 全量替换（渲染退化） |
| F6 | 通道互斥为主、eventId 去重兜底 | 空闲线程发消息时 GET 通道已被服务端关闭（回放终态即关流），POST 通道独占；打开/续传走 GET 通道；异常时序下两通道并存按 `id:` 去重（幂等 reducer） | 双通道常开（无谓双倍流量） |
| F7 | Markdown 渲染 `react-markdown` + `remark-gfm`，不做代码高亮 | 答案是 LangChain 文档问答，GFM 表格/代码块刚需；高亮可后补 | 全量 MDX/内容渲染栈（过重） |

## 5. 状态模型与归约（chatStore）

```ts
Turn = { runId, userText?: string, blocks: Block[], status: 'streaming'|'done'|'error'|'cancelled' }
Block =
  | { kind: 'reasoning', messageId, content, done }          // 思考过程（折叠）
  | { kind: 'text',       messageId, content, done }          // 助手正文
  | { kind: 'toolcall',   toolCallId, name, args, result?, done, subagentRunId? }
  | { kind: 'subagent',   subagentRunId, name, parentToolCallId, finished, blocks: Block[] }
State = { phase, turns: Turn[], activeRunId?, lastEventId, seenEventIds: Set, channelError?, fatalError? }
```

归约规则（`applyEvents(state, {eventId, event}[])`，纯函数、可测）：

- 按 `eventId` 去重（无 id 的降级事件透传）；`RUN_STARTED` 开新 Turn；终态事件置 Turn 状态并清 `activeRunId`；
- `TEXT/REASONING_MESSAGE_*` 按 `messageId` 定位/新建 block（子代理消息经 `subagentRunId` 路由进 subagent blocks）；
- `TOOL_CALL_*` 按 `toolCallId` 聚合 args 增量与 result；`SUBAGENT_STARTED` 登记 `subagentRunId → parentToolCallId`，后续子代理事件挂到对应 task 工具卡下；
- `MESSAGES_SNAPSHOT`：取最后一条 `role=user` 消息回填**当前 Turn** 的 `userText`（发送时已乐观插入则跳过）；
- `RUN_ERROR`：`code=cancelled` → `status='cancelled'`；其余 → `status='error'` + 错误信息；
- `CUSTOM retrieval.trace`：类型已定义，渲染占位（引用面板/弃答提示），当前服务端不发射。

## 6. 通道编排（ThreadController）

- **send(text)**：`activeRunId` 存在则忽略（UI 已禁用）；`runId=crypto.randomUUID()`，乐观插入用户气泡 + Turn → `POST /agui` 读流。开流前错误：409 `run_already_active` → 静默转 attach（本标签页即写方时不可能发生，跨标签页场景）；429 → 「服务繁忙，5 秒后可重试」；503 → 错误横幅；
- **open(threadId)**：`GET /threads/:id`（404 = 尚无任何 run 的新会话）→ `GET /events?afterEventId=0` 全量回放，活跃 run 自动尾随续流；
- **断线**：通道异常中断且未见终态 → 以最后 `id:` 游标走 GET 通道指数退避重连（1s→2s→4s…上限 15s），终态或 `activeRun=null` 即停；重连期间顶部细条提示「连接中断，正在重连…」；
- **重同步**：`visibilitychange`/`online` 事件触发（页面休眠期间流可能已被杀）；
- **stop()**：`POST /threads/:id/runs/:runId/cancel`；随后 RUN_ERROR{cancelled} 到达，渲染「已停止」。

新会话不显式 `POST /threads`：threadId 客户端生成，首次 `POST /agui` 自动建档并回填标题；URL 同步 `#/t/<threadId>` 供刷新恢复。

## 7. UI 结构（界面中文）

- **Sidebar**（260px）：「新对话」按钮；会话列表（标题 + 相对时间 + running 徽标，hover 删除）；底部服务状态点（`/health` 30s 轮询 + `/ready`）。
- **ChatView**：顶栏（标题）；滚动消息区；每个 Turn = 用户气泡 + **执行过程聚合块**（思考/工具调用/子代理与工具间的过程叙述一并折叠进单个可展开区块，默认收起，标题带「思考 ×a · 工具 ×b · 子代理 ×c」计数与运行状态；以最后一个活动块为界，其后 text 才是答案——2026-10-11 UX 迭代，答案首屏直达且过程叙述不占正文）+ **答案正文**（始终可见）+ 状态条。流式语义：答案文本到达时即作为正文带光标展示，若后续接了新工具调用则该段退居折叠区（与 ChatGPT/Claude 过程收拢一致）。
- **RunStatusBar**：流式脉动指示；错误横幅按 code 映射中文（timeout→「本轮超时，请重试」、server_restart→「服务重启导致中断，请重试」、server_error→「服务异常」），cancelled →「已停止」。
- **Composer**：自动增高 textarea；Enter 发送、Shift+Enter 换行；运行中发送钮变「停止」。

## 8. 工程与测试

- `packages/web`：react 19 / react-dom / react-markdown / remark-gfm / tailwindcss v4 + @tailwindcss/vite；devDeps：vite、@vitejs/plugin-react、typescript 7.0.2、vitest 4、@types/react(-dom)。scripts：`dev`/`build`/`typecheck`/`test`（接入根 `pnpm -r` 递归门槛）；根 `package.json` 增 `"dev"` 脚本。
- tsconfig 复刻 api 包（ES2022 / ESNext / bundler / strict / noEmit）+ `jsx: react-jsx` + `types: ["vite/client"]` + DOM lib。
- `.env.example`：`VITE_API_BASE_URL=http://localhost:3000`。
- 测试（Vitest，纯逻辑、node 环境、无需 jsdom）：sse 帧解析（mock ReadableStream：data/id/心跳/半包）、chatStore 归约（流式组装/回放重建/去重/快照回填/错误码/子代理挂靠）、api 错误映射、hash router。
- 最低门槛：`pnpm typecheck && pnpm test` 全绿。

## 9. 验收清单（2026-10-10 浏览器联调回填）

| # | 项 | 结果 |
|---|---|---|
| 1 | 新对话发问 → 思考/工具/子代理/答案流式渲染完整 | ✅ 多轮实测（含子代理嵌套卡片、工具卡、思考折叠、流式光标、完整 Markdown 答案） |
| 2 | **运行中刷新 → 历史恢复 + 本轮继续流式** | ✅ 刷新后全量回放重建（含进行中的流式内容），URL/标题/条数一致 |
| 3 | 运行中断流 → 自动重连补齐 | ✅ 见 7（进程级断流 + 15s 封顶指数退避重连实测） |
| 4 | 停止 → cancel →「已停止」 | ✅ cancel 端点生效，RUN_ERROR{cancelled} 渲染为非错误态，历史保留 |
| 5 | 双标签页同 thread | ✅ 第二标签页打开即自动跟随活跃 run（attach），事件零重复；409→attach 路径由单测覆盖 |
| 6 | 会话列表切换/删除/新建 | ✅ 删除后 URL 回 `#/`、回欢迎页、列表清空 |
| 7 | 服务进程死亡 → 重启 | ✅ 进程崩溃后前端持续退避重连；重启后回放消费补发的 RUN_ERROR{server_restart} →「服务重启导致中断，请重试」 |
| 8 | 429 → 「服务繁忙」 | ⚠️ 未浏览器复现（需打满 4 并发 run）；错误映射与乐观 Turn 置错由单测覆盖 |
| 9 | `pnpm typecheck && pnpm test` 全绿 | ✅ 246 全绿（rag 175 + api 31 + web 40） |

**实施发现（2026-10-10 联调）**：

1. **`packages/api` 进程级崩溃（已加兜底，系统性治理留 M9-P3）**：LangGraph StreamMux 内部微任务链上的失败以 unhandledRejection 逃逸，不经 `RunManager.execute` 的 for-await、try/catch 拦不住，默认行为是炸掉进程。联调实测三种触发源：chunk-analyst 子代理失败（`Subagent failed`，疑似 DashScope TPM 限流诱发）、DeepSeek 思考模式 400（`reasoning_content must be passed back`）。已在 `index.ts` 挂 `unhandledRejection` 兜底（记录后保活，受影响 run 由超时 abort 收口）；run 级异常归一为 RUN_ERROR{server_error} 的完整加固仍列 P3。前端在该场景的表现（重连→回放 server_restart）已实测正确。
2. **TOOL_CALL_ARGS 快照叠加 bug（已修，双层）**：LangChain v3 流对 deepseek 返回的 `tool_call_chunk.args` 是「到当前为止的完整快照」（每帧恒以前帧为前缀，抓帧实测），translator 原样透传为 AG-UI `delta`（语义应为增量）→ 前端按增量拼接后工具参数呈现为前缀串（`{{"query{"query": …`）。修复：① translator 按 toolCallId 记录已发射内容，快照只发新增后缀（增量式 provider 原样透传，单测锁定两种形态）；② 前端 chatStore 以「delta 是否以已累积内容为前缀」判别替换/追加，兼容未升级服务端。
3. **恢复顺序修正**：attachLoop 的 resume 路径必须是「先续传回放、后 meta 裁决」——服务重启后进程会清理 activeRun 并补发 `RUN_ERROR{server_restart}`，若先查 meta（activeRun 已空）会走 resolveStaleRun，用户只能看到「状态未知」而非准确的「服务重启」提示。
4. **重连横幅残留**：多个并行 attachLoop 竞态下，晚醒的循环经早退路径返回时不清除横幅（残留「正在重连（第 N 次）」）；已在 reducer 的 resolveStaleRun 与循环早退处双重复位。
5. **弃答渲染**：真实冒烟命中 rerank 闸门 ABSTAIN（4 次检索均 <0.52），最终答案为弃答文案——前端按正常 Markdown 回答渲染，符合「弃答不是错误」的契约。
6. **中间轮无 snapshot 的重试缺口**：run 被中断（无 MESSAGES_SNAPSHOT）时该轮用户消息仅在发送端有乐观值，刷新后回放无法回填 → 不显示重试按钮（重试需原问题文本）。可接受的已知限制。

## 10. 后续方向

- retrieval.trace 引用面板与弃答（ABSTAIN）提示的完整形态（依赖 M9-P3）；
- 长会话首屏优化：localStorage 游标 + `GET /messages` 快照 + 增量 attach；
- 生产部署形态：`vite build` 产物由 api 托管或独立静态服务（CORS 白名单收窄）；
- 代码高亮、消息复制、导出 Markdown。
