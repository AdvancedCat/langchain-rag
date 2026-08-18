import { z } from 'zod';
import type { Chunk, ChunkMetadata, SplitResult } from './types.js';

/**
 * Chunk 契约的运行时校验（决策 D5：扁平 metadata + extra 扩展位）。
 *
 * looseObject 允许未知字段透传：ingestion 在校验后打 `indexedAt` / `fetchedAt`
 * 不算违约；核心必需字段仍严格。
 */

export const DocTypeSchema = z.enum([
    'markdown',
    'plaintext',
    'html',
    'pdf',
    'image',
]);

export const ChunkMetadataSchema = z.looseObject({
    docId: z.string().min(1),
    contentHash: z.string().min(1),
    source: z.string().min(1),
    docType: DocTypeSchema,
    docPath: z.string().optional(),
    chunkIndex: z.number().int().min(0),
    totalChunks: z.number().int().min(1),
    title: z.string().optional(),
    sectionPath: z.array(z.string().min(1)).optional(),
    page: z.array(z.number().int().min(1)).optional(),
    slide: z.number().int().min(1).optional(),
    bbox: z.unknown().optional(),
    chunkerVersion: z.string().min(1),
    language: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
});

export const ChunkSchema = z.looseObject({
    id: z.string().min(1),
    content: z.string().min(1),
    metadata: ChunkMetadataSchema,
});

export const SplitResultSchema = z.looseObject({
    chunks: z.array(ChunkSchema),
    warnings: z.array(
        z.looseObject({
            code: z.string().min(1),
            message: z.string().min(1),
        }),
    ),
    docType: DocTypeSchema,
});

// 编译期断言：zod 输出类型 assignable 到 types.ts 手写契约（类型与运行时校验同源）。
// 只断言正向：parse() 的输入是 unknown，无需反向；looseObject 的索引签名使反向天然不成立。
type AssertAssignable<Actual extends Expected, Expected> = true;
type _ChunkMatches = AssertAssignable<z.output<typeof ChunkSchema>, Chunk>;
type _ChunkMetadataMatches = AssertAssignable<z.output<typeof ChunkMetadataSchema>, ChunkMetadata>;
type _SplitResultMatches = AssertAssignable<z.output<typeof SplitResultSchema>, SplitResult>;
