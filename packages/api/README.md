# @langchain-rag/api

文档问答 RAG Agent 的 API 服务：Koa + **AG-UI v1.0 协议**事件流（HTTP + SSE），基于 Redis 事件日志与 LangGraph checkpoint 实现**断线续传**——run 与 SSE 连接解耦，断线重连不丢事件，多轮会话可恢复。

技术方案与实施状态见 [docs/api-service-plan.md](../rag/docs/api-service-plan.md)（M9）。

## API 一览

| 方法 | 路径 | 说明 |
|-----|------|------|
| `POST` | `/agui` | AG-UI 标准运行端点：消费 `RunAgentInput`（只取最后一条 user 消息），SSE 返回 AG-UI 事件流 |
| `POST` | `/threads` | 显式建会话（`title` 缺省由首问回填） |
| `GET` | `/threads?cursor=&limit=` | 按 `updatedAt` 倒序的会话列表 |
| `GET` | `/threads/:threadId` | 会话详情（含 `activeRun`、`lastEventId`） |
| `GET` | `/threads/:threadId/messages` | 压缩历史消息快照 |
| `GET` | `/threads/:threadId/events?afterEventId=` | **断线续传核心**：SSE 先订阅 → 按 `afterEventId` 回放 → 按 `eventId` 去重 → 切入实时尾随 |
| `DELETE` | `/threads/:threadId` | 删除事件日志、元数据与 checkpoint |
| `POST` | `/threads/:threadId/runs/:runId/cancel` | 显式取消运行（断开 ≠ 取消，停止生成必须显式调用） |
| `GET` | `/health` | 存活探针：进程活着即 200，不探测下游 |
| `GET` | `/ready` | 就绪探针：agent 单例（向量库 + BM25 热启动）与 Redis 可达后 200；可触发 agent 重建（容器启动竞态免手动重启） |

## 核心机制

- **先持久化再扇出**：事件先 `appendEvent` 写入 Redis Stream 拿到 `eventId`，再扇出内存订阅者；SSE `id:` 帧即事件游标，重连凭它回放。
- **run 与 SSE 连接解耦**：订阅者断开只是退订，run 继续执行至终态；事件不丢，重连可续。
- **Run 治理**：每 thread 同时至多 1 个活跃 run（409 `run_already_active`）；进程级并发闸门 `RAG_MAX_CONCURRENT_RUNS`（429，DashScope TPM 限流防护）；`RAG_RUN_TIMEOUT_MS` 超时强制 abort（`RUN_ERROR{code:"timeout"}`）。
- **协议翻译层**：deepagents 流事件 → AG-UI 协议事件（含主/子代理事件归并）；`RETRIEVAL_TRACE_EVENTS=true` 时额外下发 `retrieval.trace` CUSTOM 事件，供前端可视化检索过程。

## 模块结构

```
api/src/
├── index.ts              # 进程入口：启动 HTTP 服务、优雅关闭
├── app.ts                # Koa 装配：CORS 白名单 + 路由挂载
├── env.ts                # 环境变量级联加载（api/.env → rag/.env，不覆盖）
├── config.ts             # 服务配置解析（PORT、并发闸门、TTL 等）
├── agentService.ts       # agent 进程内单例：向量库 + BM25 热启动构建一次，挂 Redis checkpointer
├── runManager.ts         # run 生命周期：持久化 → 扇出、单 thread 单活跃 run、超时/取消
├── agui/translator.ts    # deepagents 流事件 → AG-UI 协议事件
├── routes/               # agui / threads / health 路由
├── persistence/          # Persistence 接口：Redis 实现（生产）+ 内存实现（单测契约参照）
├── redis.ts / sse.ts     # Redis 连接 / SSE 初始化、心跳、写帧
└── __tests__/            # 单测 + Redis 持久化集成测试（Redis 不可达时整组跳过）
```

## 快速开始

```bash
# 1. 基础设施：Qdrant + Redis（在 packages/rag 下）
#    Redis 必须 ≥ 8：langgraph-checkpoint-redis 依赖 RedisJSON
cd packages/rag && make infra-up

# 2. 服务自身配置
cp .env.example .env

# 3. 启动（默认 :3000）
pnpm serve        # 或在仓库根目录 pnpm serve

# 4. 探针
curl localhost:3000/health
curl localhost:3000/ready   # 首次调用会触发 agent 懒构建，构建完成后转 200
```

LLM / Embedding / Qdrant / 检索配置不在本包维护：启动时先加载 `packages/api/.env`，再以不覆盖方式级联加载 `packages/rag/.env` 补齐（见 `src/env.ts`）。

## 环境配置

模板见 [.env.example](./.env.example)：

| 变量 | 默认 | 说明 |
|-----|------|------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `REDIS_URL` | `redis://localhost:6379` | 事件日志 / 会话元数据 / LangGraph checkpoint |
| `RAG_API_CORS_ORIGINS` | `http://localhost:5173` | 前端来源白名单，逗号分隔；`*` 关闭校验（仅限开发环境） |
| `RAG_MAX_CONCURRENT_RUNS` | `4` | 进程级 run 并发闸门（TPM 限流防护） |
| `RAG_RUN_TIMEOUT_MS` | `300000` | 单 run 执行上限，超时发 `RUN_ERROR{code:"timeout"}` |
| `THREAD_TTL_HOURS` | `720` | 事件日志与会话元数据保留期（小时） |
| `SSE_HEARTBEAT_MS` | `15000` | SSE 注释心跳间隔 |
| `RETRIEVAL_TRACE_EVENTS` | `true` | `retrieval.trace` CUSTOM 事件开关 |

## 测试

```bash
pnpm test                            # 单测；Redis 集成测试在本地 Redis 不可达时整组跳过
pnpm probe:v3 "什么是 langchain"     # 实测 deepagents 流事件形状（协议对接前置验证探针）
```
