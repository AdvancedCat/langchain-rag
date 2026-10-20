import type { Turn } from '../lib/chatStore';
import { partitionTurnBlocks } from '../lib/turnView';
import { useCopy } from '../hooks';
import { ActivitySection, BlockList } from './blocks';
import { IconCheck, IconCopy, IconSpinner } from './icons';
import { Tooltip } from './Tooltip';

/** RUN_ERROR code → 中文提示（cancelled 已在 reducer 归为非错误状态） */
const RUN_ERROR_TEXT: Record<string, string> = {
    timeout: '本轮超时，请重试',
    server_restart: '服务重启导致中断，请重试',
    server_error: '服务异常，请重试',
};

export function errorText(error: { code?: string; message: string }): string {
    return RUN_ERROR_TEXT[error.code ?? ''] ?? error.message;
}

function formatTokenCount(count: number): string {
    if (count >= 10_000) return `${Math.round(count / 1000)}K`;
    if (count >= 1_000) return `${(count / 1000).toFixed(1)}K`;
    return String(count);
}

function formatTurnTime(timestamp: number): string {
    const date = new Date(timestamp);
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

/** 复制回答按钮（设计规范 §7 复制反馈模式：check 图标 + ≤1.6s 回退，尺寸不变；失败时 label 翻为「复制失败」） */
function CopyAnswerButton({ text }: { text: string }) {
    const { copied, failed, copy } = useCopy();
    const label = failed ? '复制失败' : copied ? '已复制' : '复制回答';
    return (
        <Tooltip label={label}>
            <button
                type="button"
                onClick={() => copy(text)}
                aria-label={label}
                className="-ml-2 flex h-8 w-8 items-center justify-center rounded-md text-content-secondary transition-colors hover:bg-content/10 hover:text-content"
            >
                {copied ? <IconCheck className="h-3.5 w-3.5 text-accent" /> : <IconCopy />}
            </button>
        </Tooltip>
    );
}

/** CozeLoop traceId 复制芯片：点击复制完整 32 位 hex，悬停 title 看全量；复制反馈见 §7 通用模式 */
function TraceChip({ traceId }: { traceId: string }) {
    const { copied, failed, copy } = useCopy();
    return (
        <button
            type="button"
            onClick={() => copy(traceId)}
            title={traceId}
            className="inline-flex h-8 min-w-[124px] items-center justify-center gap-1 rounded-md border border-line px-2.5 font-mono text-[11px] tabular-nums text-content-secondary transition-colors hover:border-accent hover:text-accent"
        >
            {copied ? (
                <>
                    <IconCheck className="h-3 w-3 text-accent" />
                    已复制
                </>
            ) : failed ? (
                '复制失败'
            ) : (
                `trace ${traceId.slice(0, 8)}…`
            )}
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
    const answerText = answer.map((block) => block.content).join('\n\n');
    return (
        <div className="enter-in space-y-3">
            {turn.userText !== null ? (
                <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-content">
                        {turn.userText}
                    </div>
                </div>
            ) : streaming ? (
                <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[0.9375rem] text-content-secondary">
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

            {turn.status === 'done' ? (
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-content-secondary">
                    {answerText && <CopyAnswerButton text={answerText} />}
                    {turn.usage && turn.usage.totalTokens > 0 && (
                        <span className="tabular-nums">用量 {formatTokenCount(turn.usage.totalTokens)} tok</span>
                    )}
                    {turn.createdAt > 0 && <span className="tabular-nums">{formatTurnTime(turn.createdAt)}</span>}
                    {turn.traceId && <TraceChip traceId={turn.traceId} />}
                </div>
            ) : (
                // 流式/异常/取消轮：trace 芯片单独成行，运行中即可复制去罗盘检索
                turn.traceId && <TraceChip traceId={turn.traceId} />
            )}
        </div>
    );
}
