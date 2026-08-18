/**
 * Chunking Pipeline 契约层。
 *
 * 分层（见 docs/chunking-pipeline-plan.md §2.1）：
 *   Loader → TypeDetector → SplitterRegistry → XxxSplitter → 管道补 id → ChunkValidator
 *
 * 确定性纪律（决策 D4）：Splitter 输出不含任何时间性/随机内容；
 * `fetchedAt` 归 Loader、`indexedAt` 归 ingestion，均不入 Splitter 契约。
 */

export type DocType = 'markdown' | 'plaintext' | 'html' | 'pdf' | 'image';

export interface Chunk {
    /** 确定性 id：hash(docId + chunkIndex + content)，由管道统一补齐 */
    id: string;
    /** 干净原文，绝不掺生成内容；sectionPath 注入发生在消费侧（compose.ts） */
    content: string;
    metadata: ChunkMetadata;
}

export interface ChunkMetadata {
    // —— 定位（必需，由管道统一补齐）——
    /** canonical URL（web 语料） */
    docId: string;
    /** sha256(原文)，本地文件/去重场景的身份 */
    contentHash: string;
    /** uri，引用溯源 */
    source: string;
    docType: DocType;
    /** 语料内逻辑路径，evals 按它匹配 golden，保留为一级字段 */
    docPath?: string;
    /** 阅读顺序，从 0 连续 */
    chunkIndex: number;
    totalChunks: number;

    // —— 语义上下文（有则给，Splitter 产出）——
    /** 首个 h1 或 loader 提供 */
    title?: string;
    sectionPath?: string[];

    // —— 物理溯源（预留，本期不产出）——
    /** pdf：跨页 chunk 为数组 */
    page?: number[];
    slide?: number;
    /** pdf 高亮引用占位 */
    bbox?: unknown;

    // —— 系统（必需）——
    /** 切分器版本（version.ts），热启动守卫依据 */
    chunkerVersion: string;
    language?: string;

    // —— 扩展位：类型特有字段收这里，核心 schema 保持小而稳 ——
    extra?: Record<string, unknown>;
}

/** Loader 产物 → 切分管道的输入 */
export interface SplitDocInput {
    /** 文档正文（文本类型）；二进制类型（pdf 等）预留 bytes */
    text: string;
    /** canonical URL，作为 docId */
    docId: string;
    /** uri，引用溯源（可与 docId 相同） */
    source: string;
    /** 语料内逻辑路径 */
    docPath?: string;
    /** Loader 显式声明的类型（如 HTTP 源已知 .md 后缀） */
    declaredType?: DocType;
    /** 原始字节，供 magic bytes 识别 / 未来二进制插件 */
    bytes?: Uint8Array;
    /** 文件名提示（含扩展名） */
    filename?: string;
}

export interface SplitOptions {
    chunkSize: number;
    chunkOverlap: number;
    /** markdown header 切分的最大层级（h1-h4） */
    maxHeaderDepth: number;
}

export interface SplitWarning {
    code: string;
    message: string;
}

export interface SplitResult {
    chunks: Chunk[];
    warnings: SplitWarning[];
    /** 实际用于切分的类型（含未注册降级 plaintext 的情况） */
    docType: DocType;
}

/**
 * Splitter 的原始产出（有序数组）：管道统一补 id / docId / contentHash /
 * source / docType / chunkerVersion / totalChunks / chunkIndex（按数组下标
 * 连续编号，见 pipeline.ts），Splitter 只负责 content 与语义上下文
 * （sectionPath / title）。
 */
export interface SplitterChunk {
    content: string;
    metadata: Partial<ChunkMetadata>;
}

export interface Splitter {
    readonly docType: DocType;
    split(input: SplitDocInput, options: SplitOptions): Promise<{
        chunks: SplitterChunk[];
        warnings: SplitWarning[];
    }>;
}
