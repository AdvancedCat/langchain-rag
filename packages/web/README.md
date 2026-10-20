# @langchain-rag/web

文档问答前端的 React + Vite 聊天界面：消费 API 服务的 AG-UI 事件流，支持**双通道断线续传**与多会话管理。界面遵循极简瑞士风 + 双主题设计规范。

- 前端方案见 [docs/frontend-plan.md](../rag/docs/frontend-plan.md)（M10）
- 视觉规范见 [docs/design-system.md](docs/design-system.md)（web 子项目约束）

## 功能特性

- **多会话管理** — 侧栏会话列表 / 删除；hash 路由 `#/t/<threadId>`，链接可分享、刷新可恢复
- **流式渲染** — 答案 Markdown（GFM）+ 代码块语法高亮（rehype-highlight）；过程叙述与工具调用折叠进「思考与工具调用」聚合区块，正文只保留最终答案
- **过程可视化** — chunk-analyst 子代理事件路由进独立区块；`retrieval.trace` CUSTOM 事件已纳入视图模型归约（服务端暂未发射，M9-P3 预留）
- **来源引用** — 引用链接渲染为紧凑徽标，替代原始 URL 长列表
- **断线续传** — 写通道（`POST /agui`）异常自动转读通道（`GET /threads/:id/events`）续传；指数退避重连；按 `eventId` 幂等去重。断开 ≠ 取消，停止生成显式调 cancel 端点

## 技术栈

React 19、Vite 8、Tailwind CSS 4、react-markdown + rehype-highlight、Vitest。

刻意不引入路由库与状态库（决策 F3）：hash 路由自研，状态用纯函数归约 + 极简可观察 store，React 侧经 `useSyncExternalStore` 消费。

## 模块结构

```
web/src/
├── main.tsx / App.tsx      # 入口与装配：hash 路由 → 会话列表/服务状态/聊天 hook
├── components/
│   ├── Sidebar.tsx          #   会话侧栏（列表/新建/删除/服务状态）
│   ├── ChatView.tsx         #   消息区 + Composer
│   ├── Turn.tsx / blocks.tsx#   单轮渲染：过程聚合区块 + 最终答案
│   ├── Markdown.tsx         #   Markdown 渲染、语法高亮、来源徽标
│   └── icons.tsx
├── lib/
│   ├── threadController.ts  #   每线程一个控制器：编排写/读两条 SSE 通道、重连、去重
│   ├── chatStore.ts         #   AG-UI 事件流 → 会话视图模型的纯函数归约（一次 run = 一个 Turn）
│   ├── turnView.ts          #   Turn 视图分区：过程折叠 vs 最终答案（纯函数）
│   ├── api.ts               #   REST 客户端（threads / cancel，统一 ApiError）
│   ├── sse.ts               #   SSE 流解析
│   ├── sourceLink.ts        #   来源链接解析
│   └── router.ts            #   hash 路由（#/ ↔ #/t/<threadId>）
├── hooks.ts                 # useChat / useHashRoute / useThreads 等 React 绑定
├── env.ts                   # VITE_API_BASE_URL 解析
└── __tests__/               # store / controller / sse / api / 路由等单测
```

## 快速开始

```bash
# 前置：API 服务已启动（依赖 Qdrant + Redis）
pnpm serve   # 仓库根目录，:3000

# 启动前端 dev server
pnpm dev     # 仓库根目录或本包内，:5173

# 类型检查 / 测试 / 构建
pnpm typecheck
pnpm test
pnpm build
```

## 环境配置

模板见 [.env.example](./.env.example)：

| 变量 | 默认 | 说明 |
|-----|------|------|
| `VITE_API_BASE_URL` | `http://localhost:3000` | API 服务地址 |

dev server 固定监听 `:5173`（vite.config.ts），该端口是 api 包 CORS 白名单（`RAG_API_CORS_ORIGINS`）的默认放行来源；改端口需同步修改 api 侧白名单。
