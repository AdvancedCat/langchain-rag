// ============================================================================
// observability barrel：CozeLoop 接入的公共出口
// （api 包经 @langchain-rag/rag 主 barrel 使用，避免直接依赖 @cozeloop/ai）
// ============================================================================

export { initCozeLoop, isCozeLoopEnabled, shutdownCozeLoop } from './cozeloop.js';
export {
    withCozeLoopSpan,
    startCozeLoopSpan,
    endCozeLoopSpan,
    failCozeLoopSpan,
    setSpanInput,
    setSpanOutput,
    setSpanError,
    truncateForSpan,
    summarizeScoredChunks,
    MAX_SPAN_TEXT_CHARS,
    type CozeLoopSpanOptions,
    type ChunkSpanSummary,
    type Span,
} from './spans.js';
export { SpanKind } from './spans.js';
export {
    CozeLoopLangChainCallbackHandler,
    getCozeLoopCallbackHandler,
    getLangChainTracingCallbacks,
} from './langchain-handler.js';
export { createSubagentSpanMiddleware } from './subagent-span.js';
