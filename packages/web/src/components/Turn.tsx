import { useState } from 'react';
import type { Turn } from '../lib/chatStore';
import { partitionTurnBlocks } from '../lib/turnView';
import { ActivitySection, BlockList } from './blocks';
import { IconSpinner } from './icons';

/** RUN_ERROR code → 中文提示（cancelled 已在 reducer 归为非错误状态） */
const RUN_ERROR_TEXT: Record<string, string> = {
    timeout: '本轮超时，请重试',
    server_restart: '服务重启导致中断，请重试',
    server_error: '服务异常，请重试',
};

export function errorText(error: { code?: string; message: string }): string {
    return RUN_ERROR_TEXT[error.code ?? ''] ?? error.message;
}

/** CozeLoop traceId 复制芯片：点击复制完整 32 位 hex，悬停 title 看全量 */
function TraceChip({ traceId }: { traceId: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        void navigator.clipboard
            ?.writeText(traceId)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => undefined);
    };
    return (
        <button
            type="button"
            onClick={copy}
            title={traceId}
            className="inline-flex h-8 items-center rounded-md border border-line px-2.5 font-mono text-[11px] tabular-nums text-content-secondary transition-colors hover:border-accent hover:text-accent"
        >
            {copied ? '已复制 ✓' : `trace ${traceId.slice(0, 8)}…`}
        </button>
    );
}

/**
 * 一个 Turn = 一次问答：用户气泡 + 执行过程聚合块（过程叙述一并折叠，默认收起）
 * + 最终答案正文 + 状态条。
 */
export function TurnView({ turn, canRetry, onRetry }: { turn: Turn; canRetry: boolean; onRetry: (text: string) => void }) {
    const streaming = turn.status === 'streaming';
    const { process, answer } = partitionTurnBlocks(turn.blocks);
    return (
        <div className="space-y-3">
            {turn.userText !== null ? (
                <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-accent-fg">
                        {turn.userText}
                    </div>
                </div>
            ) : streaming ? (
                <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/25 px-4 py-2.5 text-[0.9375rem] text-accent-fg">
                        （本轮提问）
                    </div>
                </div>
            ) : null}

            <div className="space-y-2">
                {turn.blocks.length === 0 && streaming ? (
                    <div className="flex items-center gap-2 text-sm text-content-secondary">
                        <IconSpinner />
                        思考中…
                    </div>
                ) : (
                    <>
                        {process.length > 0 && <ActivitySection blocks={process} />}
                        {answer.length > 0 && <BlockList blocks={answer} />}
                    </>
                )}
            </div>

            {streaming && answer.length === 0 && turn.blocks.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-content-secondary">
                    <IconSpinner />
                    生成中…
                </div>
            )}

            {turn.status === 'cancelled' && <div className="text-xs text-content-secondary">已停止</div>}

            {turn.status === 'error' && turn.error && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-fg">
                    <span>{errorText(turn.error)}</span>
                    {canRetry && turn.userText !== null && (
                        <button
                            type="button"
                            onClick={() => onRetry(turn.userText as string)}
                            className="shrink-0 rounded-md border border-danger/40 px-2 py-0.5 text-xs font-medium text-danger-fg hover:bg-danger/10"
                        >
                            重试
                        </button>
                    )}
                </div>
            )}

            {turn.traceId && <TraceChip traceId={turn.traceId} />}
        </div>
    );
}
