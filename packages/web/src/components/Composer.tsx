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
        <div className="border-t border-zinc-200 bg-white px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    placeholder="问点什么，例如：LangChain 的 LCEL 是什么？"
                    className="thin-scrollbar max-h-[200px] min-h-[44px] flex-1 resize-none rounded-xl border border-zinc-300 px-3.5 py-2.5 text-[0.9375rem] leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
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
                        className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-zinc-800 px-4 text-sm font-medium text-white hover:bg-zinc-700"
                    >
                        <IconStop />
                        停止
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!draft.trim()}
                        className="flex h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300"
                    >
                        <IconSend />
                        发送
                    </button>
                )}
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-xs text-zinc-400">
                Enter 发送 · Shift+Enter 换行 · 回答基于 LangChain 文档检索生成
            </p>
        </div>
    );
}
