// ============================================================================
// deepagents 子代理（task 工具）span 中间件
//
// 层级问题的根因：deepagents 的 task 工具在工具体内部 `await subagent.invoke()`，
// 工具体无法从外层包裹，subagent 的 LLM 调用（回调 handler 取当前 active
// context 为父级）只能挂到根 span——CozeLoop 后台上与主模型调用平铺，看不出
// 哪些调用属于子代理。
//
// 解法：在主 agent 上注册 wrapToolCall 中间件，包住 task 工具的整段执行。
// withCozeLoopSpan 内部走 SDK traceable（startActiveSpan），AsyncLocalStorage
// 沿 await 链传播进 subagent.invoke 的整条异步链，因此子代理内部的全部 LLM
// span 自动嵌套到 task span 之下；task span 自身挂在主模型所在上下文（根
// span）下。CozeLoop 关闭时 withCozeLoopSpan 直通，行为与现状一致。
// ============================================================================

import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import {
    SpanKind,
    setSpanInput,
    setSpanOutput,
    truncateForSpan,
    withCozeLoopSpan,
} from './spans.js';

export function createSubagentSpanMiddleware(): AnyAgentMiddleware {
    return createMiddleware({
        name: 'cozeloopSubagentSpan',
        wrapToolCall: async (request, handler) => {
            if (request.toolCall.name !== 'task') return handler(request);
            const args = (request.toolCall.args ?? {}) as Record<string, unknown>;
            const subagentType =
                typeof args.subagent_type === 'string' && args.subagent_type.length > 0
                    ? args.subagent_type
                    : 'unknown';
            const description = typeof args.description === 'string' ? args.description : '';
            return withCozeLoopSpan(
                `task.${subagentType}`,
                SpanKind.Tool,
                async (span) => {
                    setSpanInput(span, {
                        subagent_type: subagentType,
                        description: truncateForSpan(description),
                    });
                    const result = await handler(request);
                    // 子代理的最终报告（ToolMessage，或 deepagents 包装的 Command）
                    setSpanOutput(span, { report: truncateForSpan(taskReport(result)) });
                    return result;
                },
            );
        },
    });
}

/** 子代理返回值（ToolMessage | Command）→ 最终报告文本，取最后一条非空 message content */
function taskReport(result: unknown): string {
    const messages = result && typeof result === 'object' && 'update' in result
        ? (result as { update?: { messages?: unknown } }).update?.messages
        : [result];
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = messageText(messages[i]);
        if (text) return text;
    }
    return '';
}

function messageText(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((block) =>
                typeof block === 'object' && block !== null && 'text' in block
                    ? String((block as { text?: unknown }).text ?? '')
                    : '',
            )
            .join('\n')
            .trim();
    }
    return '';
}
