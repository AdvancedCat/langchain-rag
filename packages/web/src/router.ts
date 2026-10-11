// ============================================================================
// 极简 hash 路由：#/ ↔ #/t/<threadId>（单路由参数，决策 F3，不引入 react-router）
// ============================================================================

const THREAD_ROUTE = /^#\/t\/([A-Za-z0-9-]+)$/;

export function parseThreadId(hash: string): string | null {
    const match = THREAD_ROUTE.exec(hash.trim());
    return match ? (match[1] as string) : null;
}

export function threadHash(threadId: string | null): string {
    return threadId === null ? '#/' : `#/t/${threadId}`;
}
