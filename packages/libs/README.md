# @langchain-rag/shared

跨包共享的 LLM provider 工厂与通用工具。当前提供 `getLLM()`：统一构造 DeepSeek Chat 模型——DeepSeek 暴露 OpenAI 兼容的 Chat Completions 端点，故复用 `ChatOpenAI` 并将其 `baseURL` 指向 DeepSeek。

全包单文件（`llm-provider.ts`），**无构建步骤**：`main` 直指 TS 源，workspace 内以相对路径 TS 直连消费（与 `packages/rag` 的库入口 `src/index.ts` 同一 no-build 约定）：

```ts
// packages/rag 内的典型用法
import { getLLM } from "../../../libs/llm-provider.js";

const agent = createDeepAgent({ model: getLLM(), /* ... */ });

// 可选：注入实例级回调（CozeLoop 观测用——工具内部直调的 llm.invoke
// 不在 graph config 传播链上，只有实例级回调能捕获）
import { getLangChainTracingCallbacks } from "../src/observability/index.js";
const llm = getLLM({ callbacks: getLangChainTracingCallbacks() });
```

模块顶层执行 `import "dotenv/config"`，导入即加载进程工作目录下的 `.env`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|-----|:---:|------|------|
| `DEEPSEEK_API_KEY` | ✅ | — | DeepSeek API Key，缺失时 `getLLM()` 直接抛错 |
| `LLM_MODEL` | — | `deepseek-v4-flash` | 模型名 |
| `DEEPSEEK_BASE_URL` | — | `https://api.deepseek.com` | API 端点（兼容代理可覆盖） |
| `LLM_TEMPERATURE` | — | `0.7` | 温度（非法值回落默认） |
| `LLM_MAX_TOKENS` | — | `4096` | 最大生成 tokens（非法值忽略） |

请求超时固定 60s。

## 工程说明

- 被 `packages/rag`（agent 与评测入口）消费，进而随 `packages/api` 间接服务在线链路；`packages/web` 不直接依赖本包。
- 本包不设 `typecheck` / `test` 脚本：类型由各消费方 tsconfig 覆盖检查，行为经消费方的用例间接覆盖。
- 新增共享工具时保持「零业务语义、纯环境变量驱动」的边界，避免反向依赖任何子包。
