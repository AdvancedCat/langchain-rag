import { useEffect, useRef } from 'react';
import { IconArrowUp, IconStop } from './icons';

/**
 * 输入区：悬浮输入卡（借鉴 DSH 面板式 Composer）——28px 面板圆角、无边框、
 * 0.5px 描边 + 淡投影悬浮在内容列底部；文本区在上，控制行在下（左提示 / 右圆钮）。
 * Enter 发送 / Shift+Enter 换行 / 输入法合成中不发送；
 * 运行中发送钮变「停止」（断开 ≠ 取消，停止走 cancel 端点）。
 */
export function Composer({
    running,
    onSend,
    onStop,
    draft,
    onDraftChange,
}: {
    running: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
    draft: string;
    onDraftChange: (text: string) => void;
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // 自动增高（上限约 8 行）：border-box 高度需补上边框宽度；未到上限时隐藏纵向溢出，
    // 否则 min-h 低于单行内容高会让输入框常态挂着滚动条
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const borders = el.offsetHeight - el.clientHeight;
        const full = el.scrollHeight + borders;
        el.style.height = `${Math.min(full, 200)}px`;
        el.style.overflowY = full > 200 ? 'auto' : 'hidden';
    }, [draft]);

    const submit = () => {
        const text = draft.trim();
        if (!text || running) return;
        onSend(text);
    };

    return (
        <div className="px-4 pb-1 pt-1 md:px-6">
            <div className="mx-auto flex max-w-3xl flex-col rounded-panel bg-composer-card shadow-card transition focus-within:ring-2 focus-within:ring-accent/20">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    placeholder="向知识库提问…"
                    className="thin-scrollbar max-h-[200px] min-h-[44px] resize-none bg-transparent px-4 pt-1.5 text-[0.9375rem] leading-relaxed text-content placeholder:text-content-secondary focus:outline-none"
                    onChange={(event) => onDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
                <div className="flex items-center justify-between gap-x-3 px-2.5 pb-2 pt-1">
                    <p className="min-w-0 flex-1 text-xs text-content-secondary">
                        Enter 发送 · Shift+Enter 换行 · 回答基于已接入的知识库生成
                    </p>
                    {running ? (
                        <button
                            type="button"
                            onClick={onStop}
                            aria-label="停止"
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-content text-canvas transition hover:bg-content/85"
                        >
                            <IconStop />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={submit}
                            disabled={!draft.trim()}
                            aria-label="发送"
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            <IconArrowUp />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
