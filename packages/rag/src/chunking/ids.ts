import { createHash } from 'node:crypto';

/** sha256(原文)，本地文件/去重场景的身份（决策 D1：docId 与 contentHash 双存） */
export function contentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 确定性 chunk id：hash(docId + chunkIndex + content)，同输入同输出 */
export function chunkId(docId: string, chunkIndex: number, content: string): string {
    return createHash('sha256')
        .update(`${docId}\u0000${chunkIndex}\u0000${content}`, 'utf8')
        .digest('hex');
}

/**
 * Qdrant point id：sha256 hex 格式化为确定性 UUID（v4 形状）。
 * 输入 64 位 hex 直接切分，其余先再哈希一次。rebuild 幂等、同文档重入覆盖不追加。
 */
export function toDeterministicUuid(hash: string): string {
    const hex = /^[0-9a-f]{64}$/.test(hash) ? hash : contentHash(hash);
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}
