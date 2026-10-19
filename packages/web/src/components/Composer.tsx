import { useEffect, useRef } from 'react';
import { IconSend, IconStop } from './icons';

/**
 * 输入区：Enter 发送 / Shift+Enter 换行 / 输入法合成中不发送；
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

    // 自动增高（上限约 8 行）
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }, [draft]);

    const submit = () => {
        const text = draft.trim();
        if (!text || running) return;
        onSend(text);
    };

    return (
        <div className="border-t border-line bg-canvas px-4 py-3 md:px-6">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    placeholder="向知识库提问…"
                    className="thin-scrollbar max-h-[200px] min-h-[44px] flex-1 resize-none rounded-xl border border-line px-3.5 py-2.5 text-[0.9375rem] leading-relaxed text-content placeholder:text-content-secondary focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20"
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
                        className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-content px-4 text-sm font-medium text-canvas transition hover:bg-content/85"
                    >
                        <IconStop />
                        停止
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!draft.trim()}
                        className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-line-strong"
                    >
                        <IconSend />
                        发送
                    </button>
                )}
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-xs text-content-secondary">
                Enter 发送 · Shift+Enter 换行 · 回答基于已接入的知识库生成
            </p>
        </div>
    );
}
