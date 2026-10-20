import { useEffect, useRef } from 'react';
import { IconArrowUp, IconStop } from './icons';

/**
 * 输入区：悬浮输入卡（借鉴 DSH 面板式 Composer）——28px 面板圆角、无边框、
 * 0.5px 描边 + 淡投影悬浮在内容列底部；单行布局，文本区为主角，
 * 圆形发送钮贴右下（随文本区长高保持锚定）。
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
        <div className="px-4 pb-4 pt-1 md:px-6">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-panel bg-composer-card py-2 pl-4 pr-2 shadow-card transition focus-within:ring-2 focus-within:ring-accent/20">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    placeholder="向知识库提问…"
                    className="thin-scrollbar max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-[0.9375rem] leading-relaxed text-content placeholder:text-content-muted focus:outline-none focus-visible:outline-none"
                    onChange={(event) => onDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
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
    );
}
