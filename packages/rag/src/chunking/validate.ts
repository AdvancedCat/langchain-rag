import { ChunkSchema } from './schema.js';
import type { Chunk, SplitWarning } from './types.js';

export interface ChunkValidation {
    valid: boolean;
    /** 硬错误：缺必需字段、chunkIndex 不连续、content 为空等，阻断入库 */
    errors: string[];
    /** 软警告：sectionPath 深度跳级、chunk 超预算等，记录不阻断 */
    warnings: SplitWarning[];
}

export interface ValidateChunksOptions {
    /** 超预算警告阈值；pipeline 按 2 倍 chunkSize 传入，容忍 splitter 对不可分行的一定超出 */
    budgetLimit: number;
}

/**
 * ChunkValidator：契约守门。单 chunk 结构交给 zod；跨 chunk 不变量
 * （chunkIndex 连续、totalChunks 一致、docId 一致、id 唯一）在此检查。
 */
export function validateChunks(
    chunks: Chunk[],
    options: ValidateChunksOptions = { budgetLimit: Number.POSITIVE_INFINITY },
): ChunkValidation {
    const errors: string[] = [];
    const warnings: SplitWarning[] = [];

    chunks.forEach((chunk, i) => {
        const parsed = ChunkSchema.safeParse(chunk);
        if (!parsed.success) {
            const detail = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ');
            errors.push(`chunks[${i}] failed schema: ${detail}`);
        }
    });

    if (chunks.length === 0) return { valid: errors.length === 0, errors, warnings };

    const firstDocId = chunks[0].metadata?.docId;
    const seenIds = new Set<string>();
    let previousPathDepth = 0;

    chunks.forEach((chunk, i) => {
        if (chunk.metadata?.docId !== firstDocId) {
            errors.push(
                `chunks[${i}].metadata.docId (${chunk.metadata?.docId}) differs from chunks[0] (${firstDocId}); pipeline must process one document at a time`,
            );
        }

        if (chunk.metadata?.chunkIndex !== i) {
            errors.push(
                `chunks[${i}].metadata.chunkIndex is ${chunk.metadata?.chunkIndex}, expected ${i} (must be contiguous from 0)`,
            );
        }

        const totalChunks = chunk.metadata?.totalChunks;
        if (totalChunks !== chunks.length) {
            errors.push(
                `chunks[${i}].metadata.totalChunks is ${totalChunks}, expected ${chunks.length}`,
            );
        }

        if (typeof chunk.id === 'string' && chunk.id.length > 0) {
            if (seenIds.has(chunk.id)) {
                errors.push(`chunks[${i}].id duplicates an earlier chunk: ${chunk.id}`);
            }
            seenIds.add(chunk.id);
        }

        if (typeof chunk.content === 'string' && chunk.content.trim().length === 0) {
            errors.push(`chunks[${i}].content is empty or whitespace-only`);
        }

        const sectionPath = chunk.metadata?.sectionPath;
        if (Array.isArray(sectionPath)) {
            // 首个 chunk 不检跳级：文档可从任意层级起头（如无 h1 直接 h2）
            if (i > 0 && sectionPath.length - previousPathDepth > 1) {
                warnings.push({
                    code: 'section-path-depth-skip',
                    message: `chunks[${i}] sectionPath depth jumps ${previousPathDepth} -> ${sectionPath.length} (${sectionPath.join(' > ')}); a header level is likely missing`,
                });
            }
            previousPathDepth = sectionPath.length;
        } else {
            previousPathDepth = 0;
        }

        if (typeof chunk.content === 'string' && chunk.content.length > options.budgetLimit) {
            warnings.push({
                code: 'chunk-over-budget',
                message: `chunks[${i}] content length ${chunk.content.length} exceeds budget limit ${options.budgetLimit}`,
            });
        }
    });

    return { valid: errors.length === 0, errors, warnings };
}
