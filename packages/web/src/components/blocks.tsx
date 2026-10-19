import { useState } from 'react';
import type { ChatBlock, SubagentBlock, ToolCallBlock } from '../lib/chatStore';
import { summarizeActivity } from '../lib/turnView';
import { Markdown } from './Markdown';
import { IconBot, IconBrain, IconCheck, IconChevron, IconSpinner, IconWrench } from './icons';

/** 已知工具名的中文标签（未知工具显示原始名） */
const TOOL_LABELS: Record<string, string> = {
    search_documentation: '文档检索',
    write_todos: '记录任务',
    task: '子代理委派',
    read_file: '读取文件',
    read_documentation: '读取文档',
};

function prettyJson(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

/** 工具调用卡片：名称 + 运行状态，展开看参数与结果 */
export function ToolCallCard({ block }: { block: ToolCallBlock }) {
    const [open, setOpen] = useState(false);
    const running = !block.done;
    const label = TOOL_LABELS[block.name] ?? block.name;
    return (
        <div className="rounded-lg border border-line bg-canvas text-sm">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-content-secondary hover:bg-surface"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconWrench />
                </span>
                <span className="font-medium">{label}</span>
                {running ? <IconSpinner /> : <IconCheck />}
            </button>
            {open && (
                <div className="space-y-2 border-t border-line px-3 py-2">
                    {block.args && (
                        <div>
                            <div className="mb-1 text-xs font-medium text-content-secondary">参数</div>
                          <pre className="thin-scrollbar max-h-40 overflow-auto rounded bg-inset p-2 text-xs text-content-secondary">
                                {prettyJson(block.args)}
                            </pre>
                        </div>
                    )}
                    {block.result !== null && (
                        <div>
                            <div className="mb-1 text-xs font-medium text-content-secondary">结果</div>
                            <pre className="thin-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded bg-inset p-2 text-xs text-content-secondary">
                                {block.result || '（空）'}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** 思考过程（reasoning）：默认折叠，流式时标题脉动 */
export function ReasoningBlockView({ block }: { block: Extract<ChatBlock, { kind: 'reasoning' }> }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="rounded-lg border border-line bg-surface/60 text-sm">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-content-secondary hover:bg-inset/60"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconBrain />
                </span>
                <span className="font-medium">思考过程</span>
                {!block.done && <IconSpinner />}
            </button>
            {open && (
                <pre className="thin-scrollbar max-h-72 overflow-auto whitespace-pre-wrap border-t border-line/70 px-3 py-2 text-xs leading-relaxed text-content-secondary">
                    {block.content}
                </pre>
            )}
        </div>
    );
}

/** 子代理组（chunk-analyst 等）：卡片内嵌套其内部工具/文本，默认折叠 */
export function SubagentGroup({ block }: { block: SubagentBlock }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="rounded-lg border border-accent/30 bg-accent-soft/40 text-sm">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-accent hover:bg-accent-soft/70"
            >
                <IconChevron open={open} />
                <span className="text-accent/70">
                    <IconBot />
                </span>
                <span className="font-medium">子代理 · {block.name}</span>
                {block.finished ? <IconCheck /> : <IconSpinner />}
            </button>
            {open && (
                <div className="space-y-2 border-t border-accent/20 px-3 py-2">
                    <BlockList blocks={block.blocks} />
                </div>
            )}
        </div>
    );
}

/** blocks 渲染（子代理内嵌套复用） */
export function BlockList({ blocks }: { blocks: ChatBlock[] }) {
    return (
        <div className="space-y-2">
            {blocks.map((block) => {
                switch (block.kind) {
                    case 'reasoning':
                        return <ReasoningBlockView key={`reasoning-${block.messageId}`} block={block} />;
                    case 'text':
                        return (
                            <div key={`text-${block.messageId}`} className="min-w-0">
                                <Markdown content={block.content} streaming={!block.done} />
                            </div>
                        );
                    case 'toolcall':
                        return <ToolCallCard key={`tool-${block.toolCallId}`} block={block} />;
                    case 'subagent':
                        return <SubagentGroup key={`sub-${block.subagentRunId}`} block={block} />;
                }
            })}
        </div>
    );
}

/**
 * 执行过程聚合区块（默认收起）：一个 Turn 的思考/工具调用/子代理折叠为单个
 * 可展开区块，标题带步骤计数与运行状态，避免中间过程占据篇幅、答案首屏可见。
 */
export function ActivitySection({ blocks }: { blocks: ChatBlock[] }) {
    const [open, setOpen] = useState(false);
    const summary = summarizeActivity(blocks);
    const parts = [
        summary.reasoning > 0 && `思考 ×${summary.reasoning}`,
        summary.tools > 0 && `工具 ×${summary.tools}`,
        summary.subagents > 0 && `子代理 ×${summary.subagents}`,
    ].filter(Boolean);
    return (
        <div className="rounded-lg border border-line bg-surface/60">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-content-secondary hover:bg-inset/60"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconBrain />
                </span>
                <span className="font-medium">思考与工具调用</span>
                <span className="text-xs text-content-secondary">{parts.join(' · ')}</span>
                <span className="ml-auto">
                    {summary.allDone ? <IconCheck /> : <IconSpinner />}
                </span>
            </button>
            {open && (
                <div className="border-t border-line/70 px-3 py-2">
                    <BlockList blocks={blocks} />
                </div>
            )}
        </div>
    );
}
