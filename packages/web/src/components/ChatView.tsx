import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../lib/chatStore';
import type { ThreadController } from '../lib/threadController';
import { BrandMark } from './BrandMark';
import { IconMenu } from './icons';
import { TurnView } from './Turn';
import { Composer } from './Composer';

const EXAMPLE_QUESTIONS = ['这个知识库里有哪些内容？', '帮我概括知识库的主要主题', '讲讲你回答问题的流程'];

/**
 * 聊天主区：状态分发（error/loading/empty/ready）+ Turn 列表 + 输入区。
 * stick-to-bottom：贴近底部时自动跟随滚动，上翻阅读则不打扰。
 */
export function ChatView({
    state,
    controller,
    title,
    threadId,
    onOpenSidebar,
}: {
    state: ChatState;
    controller: ThreadController;
    title: string;
    threadId: string | null;
    onOpenSidebar: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const [draft, setDraft] = useState('');

    const lastTurn = state.turns.at(-1);
    const lastContentSignature = state.turns
        .map((turn) => `${turn.runId}:${turn.blocks.length}:${turn.blocks.at(-1)?.kind === 'text' || turn.blocks.at(-1)?.kind === 'reasoning' ? JSON.stringify(turn.blocks.at(-1)) : ''}`)
        .join('|');

    useEffect(() => {
        if (!stickRef.current) return;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [state.turns.length, lastContentSignature, state.phase]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };

    const send = (text: string) => {
        setDraft('');
        stickRef.current = true;
        void controller.send(text);
    };

    return (
        <main className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
            <header className="flex h-13 items-center gap-2 border-b border-line px-4 py-3 md:px-5">
                <button
                    type="button"
                    onClick={onOpenSidebar}
                    aria-label="打开侧栏"
                    title="打开侧栏"
                    className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-secondary transition-colors hover:bg-inset hover:text-content md:hidden"
                >
                    <IconMenu />
                </button>
                <h1 className="truncate text-sm font-semibold text-content">{title}</h1>
                {state.activeRunId !== null && (
                    <span className="ml-3 flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-fg">
                        <span className="h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-success" />
                        回答生成中
                    </span>
                )}
            </header>

            {state.channel.state === 'reconnecting' && (
                <div className="border-b border-warning/30 bg-warning-soft px-5 py-1.5 text-center text-xs text-warning-fg">
                    连接中断，正在重连…（第 {state.channel.attempt} 次）
                </div>
            )}

            {state.phase === 'error' ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <p className="text-sm text-danger-fg">{state.loadError?.message ?? '会话加载失败'}</p>
                    <button
                        type="button"
                        onClick={() => void controller.open(threadId)}
                        className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-content hover:bg-surface"
                    >
                        重新加载
                    </button>
                </div>
            ) : state.phase === 'loading' ? (
                <div className="flex flex-1 items-center justify-center text-sm text-content-secondary">正在恢复会话…</div>
            ) : state.turns.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-fg">
                        <BrandMark className="h-8 w-8" />
                    </div>
                    <div className="text-center">
                        <h2 className="text-lg font-semibold text-content">知识库问答</h2>
                        <p className="mt-1 text-sm text-content-secondary">基于已接入的知识库检索与多代理分析生成，回答附完整过程</p>
                    </div>
                    <div className="flex max-w-lg flex-wrap justify-center gap-2">
                        {EXAMPLE_QUESTIONS.map((question) => (
                            <button
                                key={question}
                                type="button"
                                onClick={() => send(question)}
                                className="rounded-full border border-line bg-canvas px-3.5 py-1.5 text-xs text-content-secondary transition hover:border-accent hover:text-accent"
                            >
                                {question}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <div ref={scrollRef} onScroll={onScroll} className="thin-scrollbar flex-1 overflow-y-auto px-4 py-5 md:px-6">
                    <div className="mx-auto max-w-3xl space-y-8">
                        {state.turns.map((turn, index) => (
                            <TurnView
                                key={turn.runId}
                                turn={turn}
                                canRetry={index === state.turns.length - 1 && state.activeRunId === null}
                                onRetry={send}
                            />
                        ))}
                        {lastTurn === undefined && <span />}
                    </div>
                </div>
            )}

            <Composer
                running={state.activeRunId !== null}
                onSend={send}
                onStop={() => void controller.stop()}
                draft={draft}
                onDraftChange={setDraft}
            />
        </main>
    );
}
