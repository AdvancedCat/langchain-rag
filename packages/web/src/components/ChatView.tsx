import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../lib/chatStore';
import type { ThreadController } from '../lib/threadController';
import { TurnView } from './Turn';
import { Composer } from './Composer';

const EXAMPLE_QUESTIONS = [
    'LangChain 的 LCEL 是什么？',
    '如何用 LangGraph 构建多代理系统？',
    'hybrid retrieval（混合检索）怎么配置？',
];

/**
 * 聊天主区：状态分发（error/loading/empty/ready）+ Turn 列表 + 输入区。
 * stick-to-bottom：贴近底部时自动跟随滚动，上翻阅读则不打扰。
 */
export function ChatView({
    state,
    controller,
    title,
    threadId,
}: {
    state: ChatState;
    controller: ThreadController;
    title: string;
    threadId: string | null;
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
        <main className="flex h-full min-w-0 flex-1 flex-col bg-white">
            <header className="flex h-13 items-center border-b border-zinc-200 px-5 py-3">
                <h1 className="truncate text-sm font-semibold text-zinc-700">{title}</h1>
                {state.activeRunId !== null && (
                    <span className="ml-3 flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                        回答生成中
                    </span>
                )}
            </header>

            {state.channel.state === 'reconnecting' && (
                <div className="border-b border-amber-200 bg-amber-50 px-5 py-1.5 text-center text-xs text-amber-700">
                    连接中断，正在重连…（第 {state.channel.attempt} 次）
                </div>
            )}

            {state.phase === 'error' ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <p className="text-sm text-red-600">{state.loadError?.message ?? '会话加载失败'}</p>
                    <button
                        type="button"
                        onClick={() => void controller.open(threadId)}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
                    >
                        重新加载
                    </button>
                </div>
            ) : state.phase === 'loading' ? (
                <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">正在恢复会话…</div>
            ) : state.turns.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-lg font-bold text-white">R</div>
                    <div className="text-center">
                        <h2 className="text-lg font-semibold text-zinc-800">LangChain 文档问答</h2>
                        <p className="mt-1 text-sm text-zinc-400">基于向量 + BM25 混合检索与多代理分析，回答附完整过程</p>
                    </div>
                    <div className="flex max-w-lg flex-wrap justify-center gap-2">
                        {EXAMPLE_QUESTIONS.map((question) => (
                            <button
                                key={question}
                                type="button"
                                onClick={() => send(question)}
                                className="rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-xs text-zinc-600 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600"
                            >
                                {question}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <div ref={scrollRef} onScroll={onScroll} className="thin-scrollbar flex-1 overflow-y-auto px-4 py-5">
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
