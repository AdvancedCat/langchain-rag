// ============================================================================
// span 包装器与脱敏 helpers：disabled 直通、traceable 选项、手动 span 生命周期、
// chunk 摘要不带全文（方案 §3.5）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cozeLoopTracer } from '@cozeloop/ai';
import type { Span } from '../spans.js';

const mocks = vi.hoisted(() => {
    const makeFakeSpan = () => {
        const attributes: Record<string, unknown> = {};
        return {
            attributes,
            setAttribute(key: string, value: unknown) {
                attributes[key] = value;
            },
            end: vi.fn(),
        };
    };
    const startSpan = vi.fn((_name: string, options?: { attributes?: Record<string, unknown> }) => {
        const span = makeFakeSpan();
        for (const [key, value] of Object.entries(options?.attributes ?? {})) {
            span.setAttribute(key, value);
        }
        return span;
    });
    return { makeFakeSpan, startSpan };
});

vi.mock('@cozeloop/ai', () => ({
    cozeLoopTracer: {
        initialize: vi.fn(),
        forceFlush: vi.fn(),
        shutdown: vi.fn(),
        traceable: vi.fn(
            (fn: (span: unknown) => unknown) => fn(mocks.makeFakeSpan()),
        ),
        getTracer: () => ({ startSpan: mocks.startSpan }),
        setInput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_input', value),
        setOutput: (span: ReturnType<typeof mocks.makeFakeSpan>, value: unknown) =>
            span.setAttribute('cozeloop_span_output', value),
        setError: (span: ReturnType<typeof mocks.makeFakeSpan>, msg?: string) =>
            span.setAttribute('error', msg ?? 'unknown'),
    },
    SpanKind: {
        PromptHub: 'prompt_hub',
        PromptTemplate: 'prompt',
        Model: 'model',
        Retriever: 'retriever',
        Tool: 'tool',
    },
    COZELOOP_TRACE_BASIC_TAGS: {
        SPAN_NAME: 'cozeloop_span_name',
        SPAN_TYPE: 'cozeloop_span_type',
        SPAN_INPUT: 'cozeloop_span_input',
        SPAN_OUTPUT: 'cozeloop_span_output',
    },
    COZELOOP_TRACE_BUSINESS_TAGS: {},
}));

vi.mock('../cozeloop.js', () => ({
    isCozeLoopEnabled: vi.fn(() => false),
}));

import { isCozeLoopEnabled } from '../cozeloop.js';
import {
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
} from '../spans.js';

beforeEach(() => {
    vi.mocked(isCozeLoopEnabled).mockReturnValue(false);
    vi.mocked(cozeLoopTracer.traceable).mockClear();
    mocks.startSpan.mockClear();
});

describe('withCozeLoopSpan', () => {
    it('禁用时直通：fn 收到 null，不触碰 SDK', async () => {
        const fn = vi.fn(async (span: Span | null) => {
            expect(span).toBeNull();
            return 42;
        });
        await expect(withCozeLoopSpan('retrieval', 'retriever', fn)).resolves.toBe(42);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(cozeLoopTracer.traceable).not.toHaveBeenCalled();
    });

    it('启用时经 traceable 包裹：默认不序列化入参/返回值，fn 收到 span', async () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
        let seen: Span | null = null;
        const result = await withCozeLoopSpan('retrieval', 'retriever', async (span) => {
            seen = span;
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(seen).not.toBeNull();
        const options = vi.mocked(cozeLoopTracer.traceable).mock.calls[0][1] as unknown as Record<string, unknown>;
        expect(options).toMatchObject({
            name: 'retrieval',
            type: 'retriever',
            recordInputs: false,
            recordOutputs: false,
        });
    });

    it('调用方选项可覆盖默认值（如工具 span 打开 recordOutputs）', async () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
        await withCozeLoopSpan('search_documentation', 'tool', async () => 'done', {
            recordOutputs: true,
            attributes: { foo: 'bar' },
        });
        const options = vi.mocked(cozeLoopTracer.traceable).mock.calls[0][1] as unknown as Record<string, unknown>;
        expect(options).toMatchObject({
            recordInputs: false,
            recordOutputs: true,
            attributes: { foo: 'bar' },
        });
    });

    it('禁用路径异常原样抛出', async () => {
        await expect(
            withCozeLoopSpan('x', 'y', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
    });
});

describe('手动 span 生命周期', () => {
    it('startCozeLoopSpan 禁用返回 null', () => {
        expect(startCozeLoopSpan('retrieval.gate', 'retriever')).toBeNull();
        expect(mocks.startSpan).not.toHaveBeenCalled();
    });

    it('startCozeLoopSpan 启用时以 `${name}.${type}` 建 span 并打 name/type 基础标签', () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
        const span = startCozeLoopSpan('retrieval.gate', 'retriever', {
            attributes: { threshold: 0.52 },
        }) as unknown as ReturnType<typeof mocks.makeFakeSpan>;
        expect(mocks.startSpan).toHaveBeenCalledWith('retrieval.gate.retriever', {
            attributes: expect.objectContaining({
                cozeloop_span_name: 'retrieval.gate',
                cozeloop_span_type: 'retriever',
                threshold: 0.52,
            }),
        });
        expect(span.attributes['cozeloop_span_name']).toBe('retrieval.gate');
    });

    it('setSpanInput/Output/Error 对 null 安全；对 span 写属性', () => {
        vi.mocked(isCozeLoopEnabled).mockReturnValue(true);
        const span = startCozeLoopSpan('x', 'y') as unknown as ReturnType<typeof mocks.makeFakeSpan>;
        expect(() => {
            setSpanInput(null, { a: 1 });
            setSpanOutput(null, { b: 2 });
            setSpanError(null, new Error('x'));
        }).not.toThrow();
        setSpanOutput(span as unknown as Span, { out: true });
        setSpanError(span as unknown as Span, new Error('bad'));
        expect(span.attributes['cozeloop_span_output']).toEqual({ out: true });
        expect(span.attributes['error']).toBe('bad');
    });

    it('endCozeLoopSpan 带输出时先写 output 再 end；null 安全', () => {
        const span = mocks.makeFakeSpan();
        endCozeLoopSpan(span as unknown as Span, { decision: 'PASS' });
        expect(span.attributes['cozeloop_span_output']).toEqual({ decision: 'PASS' });
        expect(span.end).toHaveBeenCalledTimes(1);
        expect(() => endCozeLoopSpan(null)).not.toThrow();
    });

    it('failCozeLoopSpan 写 error 与 output 后 end', () => {
        const span = mocks.makeFakeSpan();
        failCozeLoopSpan(span as unknown as Span, new Error('api down'), { fallback: true });
        expect(span.attributes['error']).toBe('api down');
        expect(span.attributes['cozeloop_span_output']).toEqual({ fallback: true });
        expect(span.end).toHaveBeenCalledTimes(1);
    });
});

describe('脱敏 helpers', () => {
    it('truncateForSpan 短文本原样，长文本截断并标注截断量', () => {
        expect(truncateForSpan('hello')).toBe('hello');
        const long = 'a'.repeat(MAX_SPAN_TEXT_CHARS + 100);
        const truncated = truncateForSpan(long);
        expect(truncated.length).toBeLessThan(long.length);
        expect(truncated).toMatch(/\[truncated 100 chars\]$/);
    });

    it('summarizeScoredChunks 输出 docPath/分数摘要，不含 pageContent', () => {
        const chunks = [
            {
                document: {
                    pageContent: 'SECRET CHUNK BODY'.repeat(50),
                    metadata: { docPath: 'docs/foo.md', chunkIndex: 3, source: 'https://example.com/foo' },
                },
                score: 0.91234,
                retrievalSource: 'hybrid' as const,
                rerankScore: 0.87654,
            },
        ];
        const summary = summarizeScoredChunks(chunks);
        expect(summary).toHaveLength(1);
        expect(summary[0]).toEqual({
            docPath: 'docs/foo.md',
            chunkIndex: 3,
            score: 0.9123,
            rerankScore: 0.8765,
            retrievalSource: 'hybrid',
        });
        expect(JSON.stringify(summary)).not.toContain('SECRET CHUNK BODY');
    });

    it('summarizeScoredChunks 遵守 limit 且缺失 docPath 时回退 source/unknown', () => {
        const chunks = Array.from({ length: 5 }, (_, i) => ({
            document: { pageContent: 'x', metadata: { source: `src-${i}` } },
            score: i,
            retrievalSource: 'dense' as const,
        }));
        const summary = summarizeScoredChunks(chunks, 2);
        expect(summary.map((s) => s.docPath)).toEqual(['src-0', 'src-1']);
        expect(summarizeScoredChunks([
            { document: { pageContent: 'x', metadata: {} }, score: 1, retrievalSource: 'dense' },
        ])[0].docPath).toBe('unknown');
    });
});
