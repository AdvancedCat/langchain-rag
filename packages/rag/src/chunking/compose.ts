/**
 * 消费侧组装的唯一实现（决策 D3）：存储侧始终是干净 content + 结构化字段，
 * sectionPath 注入发生在 embedding / BM25 / rerank / MMR 四个消费点。
 */
export function composeSearchText(
    content: string,
    metadata?: Record<string, unknown>,
): string {
    const sectionPath = extractSectionPath(metadata);
    if (!sectionPath) return content;
    return `${sectionPath.join(' > ')}\n\n${content}`;
}

/** 防御式提取 sectionPath：旧 collection / 手写 metadata 可能缺字段或类型不符 */
export function extractSectionPath(
    metadata?: Record<string, unknown>,
): string[] | undefined {
    if (!metadata) return undefined;
    const raw = metadata.sectionPath;
    if (!Array.isArray(raw)) return undefined;
    const parts = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts : undefined;
}
