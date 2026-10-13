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

import { cozeLoopTracer, COZELOOP_TRACE_BASIC_TAGS, type LoopTraceWrapperOptions, type Span } from '@cozeloop/ai';
import { isCozeLoopEnabled } from './cozeloop.js';
import type { ScoredChunk } from '../retrieval/types.js';

export type { Span };
export { SpanKind } from '@cozeloop/ai';

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

/** 手动开启一个 span（父级取当前异步链的 active context）；禁用返回 null */
export function startCozeLoopSpan(
    name: string,
    type: string,
    options: { attributes?: Record<string, string | number | boolean> } = {},
): Span | null {
    if (!isCozeLoopEnabled()) return null;
    // 与 SDK traceable 内部约定一致：OTel span 名 `${name}.${type}` + name/type 基础标签
    return cozeLoopTracer.getTracer().startSpan(`${name}.${type}`, {
        attributes: {
            [COZELOOP_TRACE_BASIC_TAGS.SPAN_NAME]: name,
            [COZELOOP_TRACE_BASIC_TAGS.SPAN_TYPE]: type,
            ...options.attributes,
        },
    });
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
