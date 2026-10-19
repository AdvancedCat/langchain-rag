// ============================================================================
// CozeLoop span 包装器与数据脱敏 helpers
//
// 两条使用路径：
// - withCozeLoopSpan：start/end 同体的阶段函数（检索管线各阶段、工具体、run 根）
// - startCozeLoopSpan / endCozeLoopSpan / failCozeLoopSpan：生命周期分离的场景
//   （LangChain 回调、弃答闸门：早退 return 多，不适合整段包裹）
//
// Span/OTel 类型一律经 @cozeloop/ai 再导出——OTel API 是全局单例语义，
// 宿主直接依赖 @opentelemetry/api 会产生第二实例导致 context 不互通（方案 §2）。
// ============================================================================

import { cozeLoopTracer, COZELOOP_TRACE_BASIC_TAGS, context, type LoopTraceWrapperOptions, type Span } from '@cozeloop/ai';
import { isCozeLoopEnabled } from './cozeloop.js';
import type { ScoredChunk } from '../retrieval/types.js';

export type { Span };
export { SpanKind } from '@cozeloop/ai';

/** OTel Context（经 @cozeloop/ai 再导出的全局单例，宿主不得直依赖 @opentelemetry/api） */
type OtelContext = ReturnType<typeof context.active>;

/**
 * LangChain config.metadata 键：invoke 侧显式携带父 context，供回调 handler
 * 建(model) span 时采用（见 cozeloopParentMetadata / langchain-handler）。
 */
export const COZELOOP_PARENT_CONTEXT_METADATA = 'cozeloop.parent_context';

export type CozeLoopSpanOptions = Partial<
    Pick<LoopTraceWrapperOptions, 'attributes' | 'baggages' | 'recordInputs' | 'recordOutputs' | 'ultraLargeReport'>
>;

/** 自由文本上报上限：超出截断（chunk 全文/长 prompt 不进 span） */
export const MAX_SPAN_TEXT_CHARS = 2000;

/**
 * 包裹一段异步逻辑为 CozeLoop span。禁用时直通原函数（fn 收到 null），
 * 一次布尔判断开销——评测批跑等未配置场景行为与现状完全一致。
 */
export async function withCozeLoopSpan<T>(
    name: string,
    type: string,
    fn: (span: Span | null) => Promise<T>,
    options: CozeLoopSpanOptions = {},
): Promise<T> {
    if (!isCozeLoopEnabled()) return fn(null);
    return cozeLoopTracer.traceable(
        async (span: Span) => fn(span),
        // 默认不自动序列化入参/返回值（闭包捕获体会被整包上报），由调用方按需 setSpanInput/Output
        { name, type, recordInputs: false, recordOutputs: false, ...options },
    );
}

/** 手动开启一个 span（父级取当前异步链的 active context，或显式指定）；禁用返回 null */
export function startCozeLoopSpan(
    name: string,
    type: string,
    options: { attributes?: Record<string, string | number | boolean>; parent?: OtelContext } = {},
): Span | null {
    if (!isCozeLoopEnabled()) return null;
    // 与 SDK traceable 内部约定一致：OTel span 名 `${name}.${type}` + name/type 基础标签
    const attributes = {
        [COZELOOP_TRACE_BASIC_TAGS.SPAN_NAME]: name,
        [COZELOOP_TRACE_BASIC_TAGS.SPAN_TYPE]: type,
        ...options.attributes,
    };
    return options.parent !== undefined
        ? cozeLoopTracer.getTracer().startSpan(`${name}.${type}`, { attributes }, options.parent)
        : cozeLoopTracer.getTracer().startSpan(`${name}.${type}`, { attributes });
}

/**
 * LangChain invoke config 片段：把当前 active context 经 config.metadata 引用
 * 传给回调 handler，供其建 model span 时显式指定父级。
 *
 * 为什么不能依赖 ambient：工具体内直调的 llm.invoke（query rewrite / multiQuery）
 * 只走实例级回调，且并行 tool 执行下 LangChain 回调分发脱离 AsyncLocalStorage
 * store——ambient 只剩 run 根，model span 泄漏到根层级、平铺在工具 span 之后
 * （同层按 started_at 排序，观感像"生成工具入参的 LLM 晚于工具执行"）。
 * config 是引用传递，不经 ALS，天然免疫。禁用时返回空对象，invoke 行为不变。
 */
export function cozeloopParentMetadata(): { metadata?: Record<string, unknown> } {
    if (!isCozeLoopEnabled()) return {};
    return { metadata: { [COZELOOP_PARENT_CONTEXT_METADATA]: context.active() } };
}

export function setSpanInput(span: Span | null, value: unknown): void {
    if (span) cozeLoopTracer.setInput(span, value);
}

export function setSpanOutput(span: Span | null, value: unknown): void {
    if (span) cozeLoopTracer.setOutput(span, value);
}

export function setSpanError(span: Span | null, error: unknown): void {
    if (span) cozeLoopTracer.setError(span, error instanceof Error ? error.message : String(error));
}

export function endCozeLoopSpan(span: Span | null, output?: unknown): void {
    if (!span) return;
    if (output !== undefined) setSpanOutput(span, output);
    span.end();
}

export function failCozeLoopSpan(span: Span | null, error: unknown, output?: unknown): void {
    if (!span) return;
    setSpanError(span, error);
    if (output !== undefined) setSpanOutput(span, output);
    span.end();
}

// ---------------------------------------------------------------------------
// 脱敏：span 里不进 chunk 全文，自由文本限长（方案 §3.5）
// ---------------------------------------------------------------------------

export function truncateForSpan(text: string, max: number = MAX_SPAN_TEXT_CHARS): string {
    return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

export interface ChunkSpanSummary {
    docPath: string;
    chunkIndex: number | string;
    score: number;
    rerankScore?: number;
    retrievalSource: string;
}

/** chunk 列表 → 有界摘要（docPath/分数，不带 pageContent） */
export function summarizeScoredChunks(chunks: ScoredChunk[], limit = 10): ChunkSpanSummary[] {
    return chunks.slice(0, limit).map((chunk) => {
        const metadata = chunk.document.metadata as Record<string, unknown> | undefined;
        const docPath =
            typeof metadata?.docPath === 'string'
                ? metadata.docPath
                : typeof metadata?.source === 'string'
                  ? metadata.source
                  : 'unknown';
        return {
            docPath,
            chunkIndex: typeof metadata?.chunkIndex === 'number' ? metadata.chunkIndex : '?',
            score: Number(chunk.score.toFixed(4)),
            ...(chunk.rerankScore !== undefined ? { rerankScore: Number(chunk.rerankScore.toFixed(4)) } : {}),
            retrievalSource: chunk.retrievalSource,
        };
    });
}
