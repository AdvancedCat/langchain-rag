import type {
    Chunk,
    ChunkMetadata,
    DocType,
    SplitDocInput,
    SplitOptions,
    SplitResult,
    SplitWarning,
} from './types.js';
import { detectDocType } from './detect.js';
import { SplitterRegistry, createDefaultRegistry } from './registry.js';
import { contentHash, chunkId } from './ids.js';
import { validateChunks } from './validate.js';
import { CHUNKER_VERSION } from './version.js';

export const DEFAULT_SPLIT_OPTIONS: SplitOptions = {
    chunkSize: 1000,
    chunkOverlap: 200,
    maxHeaderDepth: 4,
};

/** 超预算警告阈值：2 倍 chunkSize，容忍 splitter 对不可分行的一定超出 */
const BUDGET_MULTIPLIER = 2;

export class ChunkValidationError extends Error {
    constructor(public readonly errors: string[]) {
        super(`Chunk validation failed:\n- ${errors.join('\n- ')}`);
        this.name = 'ChunkValidationError';
    }
}

/**
 * 切分管道（plan §2.1）：
 * detect → registry 分发 → split → 管道统一补确定性字段 → ChunkValidator。
 *
 * 单文档硬校验失败抛 ChunkValidationError，由 ingestion 捕获降级为跳过 +
 * 记录（错误隔离）；诊断信息经 warnings 透出。
 */
export async function runChunkingPipeline(
    input: SplitDocInput,
    options: Partial<SplitOptions> = {},
    registry: SplitterRegistry = createDefaultRegistry(),
): Promise<SplitResult> {
    const warnings: SplitWarning[] = [];

    const detection = detectDocType(input);
    warnings.push(...detection.warnings);

    let docType = detection.docType;
    let splitter = registry.get(docType);
    if (!splitter) {
        warnings.push({
            code: 'splitter-not-registered',
            message: `No splitter registered for "${docType}" (detected via ${detection.via}); falling back to plaintext`,
        });
        docType = 'plaintext';
        splitter = registry.get('plaintext');
    }

    if (!splitter) {
        throw new Error('No plaintext splitter registered; the registry must always provide a fallback');
    }

    const splitOptions: SplitOptions = { ...DEFAULT_SPLIT_OPTIONS, ...options };
    const { chunks: rawChunks, warnings: splitWarnings } = await splitter.split(input, splitOptions);
    warnings.push(...splitWarnings);

    const effectiveChunks = rawChunks.filter((chunk) => chunk.content.trim().length > 0);
    const chunks: Chunk[] = effectiveChunks.map((chunk, index): Chunk => {
        const metadata: ChunkMetadata = {
            ...chunk.metadata,
            docId: input.docId,
            contentHash: contentHash(chunk.content),
            source: input.source,
            docType,
            ...(input.docPath !== undefined ? { docPath: input.docPath } : {}),
            chunkIndex: index,
            totalChunks: effectiveChunks.length,
            chunkerVersion: CHUNKER_VERSION,
        };
        return {
            id: chunkId(input.docId, index, chunk.content),
            content: chunk.content,
            metadata,
        };
    });

    const validation = validateChunks(chunks, {
        budgetLimit: splitOptions.chunkSize * BUDGET_MULTIPLIER,
    });
    warnings.push(...validation.warnings);
    if (!validation.valid) {
        throw new ChunkValidationError(validation.errors);
    }

    return { chunks, warnings, docType };
}
