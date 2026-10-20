import { useState, type ReactNode } from 'react';
import type { ChatBlock, SubagentBlock, ToolCallBlock } from '../lib/chatStore';
import { summarizeActivity } from '../lib/turnView';
import { Markdown } from './Markdown';
import {
    IconBot,
    IconBrain,
    IconCheck,
    IconChevron,
    IconSpinner,
    IconWorkflow,
    IconWrench,
} from './icons';

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

/**
 * 折叠容器（设计规范 §8）：grid-template-rows 0fr→1fr 过渡，禁止瞬时跳变；
 * 进入 ease-out、退出 ease-in；reduced-motion 降级为直接展开。
 * 内容保持挂载以承载动画，收起时置 inert——否则内部链接/复制按钮仍在 Tab 序列里。
 */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
    return (
        <div
            className={`grid motion-safe:transition-[grid-template-rows] motion-safe:duration-base ${
                open ? 'grid-rows-[1fr] motion-safe:ease-out' : 'grid-rows-[0fr] motion-safe:ease-in'
            }`}
        >
            <div className="min-h-0 overflow-hidden" inert={!open}>
                {children}
            </div>
        </div>
    );
}

/**
 * 时间线步骤外壳（设计规范 §7）：8px 类型色节点 + 2px line 连接线（.tl-step），
 * 内容区左 3px 类型色条，不再各自带边框。
 */
function TimelineStep({
    dot,
    bar,
    children,
}: {
    dot: string;
    bar: string;
    children: ReactNode;
}) {
    return (
        <li className="tl-step enter-in">
            <span aria-hidden="true" className={`tl-dot ${dot}`} />
            <div className={`min-w-0 flex-1 border-l-[3px] pl-2.5 ${bar}`}>{children}</div>
        </li>
    );
}

/** 工具调用步骤：名称 + 运行状态，展开看参数与结果 */
export function ToolCallStep({ block }: { block: ToolCallBlock }) {
    const [open, setOpen] = useState(false);
    const running = !block.done;
    const label = TOOL_LABELS[block.name] ?? block.name;
    return (
        <TimelineStep dot="bg-process-tool" bar="border-l-process-tool">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 py-1 text-left text-sm text-content-secondary transition-colors hover:text-content"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconWrench />
                </span>
                <span className="font-medium">{label}</span>
                <span className="ml-auto">
                    {running ? <IconSpinner /> : <IconCheck />}
                </span>
            </button>
            <Collapsible open={open}>
                <div className="space-y-2 pb-1.5 pt-1">
                    {block.args && (
                        <div>
                            <div className="mb-1 text-xs font-medium text-content-secondary">参数</div>
                            <pre className="thin-scrollbar max-h-40 overflow-auto rounded-md bg-inset p-2 text-xs text-content-secondary">
                                {prettyJson(block.args)}
                            </pre>
                        </div>
                    )}
                    {block.result !== null && (
                        <div>
                            <div className="mb-1 text-xs font-medium text-content-secondary">结果</div>
                            <pre className="thin-scrollbar max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-inset p-2 text-xs text-content-secondary">
                                {block.result || '（空）'}
                            </pre>
                        </div>
                    )}
                </div>
            </Collapsible>
        </TimelineStep>
    );
}

/** 思考过程步骤（reasoning）：默认折叠，流式时标题脉动 */
export function ReasoningStep({ block }: { block: Extract<ChatBlock, { kind: 'reasoning' }> }) {
    const [open, setOpen] = useState(false);
    return (
        <TimelineStep dot="bg-process-reasoning" bar="border-l-process-reasoning">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 py-1 text-left text-sm text-content-secondary transition-colors hover:text-content"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconBrain />
                </span>
                <span className="font-medium">思考过程</span>
                {!block.done && <IconSpinner />}
            </button>
            <Collapsible open={open}>
                <pre className="thin-scrollbar mb-1.5 mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-inset p-2 text-xs leading-relaxed text-content-secondary">
                    {block.content}
                </pre>
            </Collapsible>
        </TimelineStep>
    );
}

/** 子代理步骤（chunk-analyst 等）：卡片内嵌套其内部块的时间线，默认折叠 */
export function SubagentStep({ block }: { block: SubagentBlock }) {
    const [open, setOpen] = useState(false);
    return (
        <TimelineStep dot="bg-process-subagent" bar="border-l-process-subagent">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 py-1 text-left text-sm text-accent transition-colors hover:text-accent-hover"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconBot />
                </span>
                <span className="font-medium">子代理 · {block.name}</span>
                <span className="ml-auto">
                    {block.finished ? <IconCheck /> : <IconSpinner />}
                </span>
            </button>
            <Collapsible open={open}>
                <div className="pb-1.5 pt-1">
                    <BlockList blocks={block.blocks} />
                </div>
            </Collapsible>
        </TimelineStep>
    );
}

/** blocks 渲染（子代理内嵌套复用）：过程块为时间线步骤，正文文本缩进对齐步骤内容 */
export function BlockList({ blocks }: { blocks: ChatBlock[] }) {
    return (
        <ol className="space-y-2">
            {blocks.map((block) => {
                switch (block.kind) {
                    case 'reasoning':
                        return <ReasoningStep key={`reasoning-${block.messageId}`} block={block} />;
                    case 'text':
                        return (
                            <li key={`text-${block.messageId}`} className="min-w-0 pl-[18px]">
                                <Markdown content={block.content} streaming={!block.done} />
                            </li>
                        );
                    case 'toolcall':
                        return <ToolCallStep key={`tool-${block.toolCallId}`} block={block} />;
                    case 'subagent':
                        return <SubagentStep key={`sub-${block.subagentRunId}`} block={block} />;
                }
            })}
        </ol>
    );
}

/**
 * 执行过程聚合区块（默认收起）：一个 Turn 的思考/工具调用/子代理折叠为单个
 * 可展开区块，展开区为垂直时间线（设计规范 §7）。头部：chevron + 聚合专属图标
 * （Workflow，与思考块 Brain 拆分）+ 标签 + 步骤计数 + 运行状态。
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
        <div className="rounded-lg border border-line bg-surface">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-inset/60 hover:text-content"
            >
                <IconChevron open={open} />
                <span className="text-content-muted">
                    <IconWorkflow />
                </span>
                <span className="font-medium">思考与工具调用</span>
                <span className="text-xs text-content-secondary">{parts.join(' · ')}</span>
                <span className="ml-auto">
                    {summary.allDone ? <IconCheck /> : <IconSpinner />}
                </span>
            </button>
            <Collapsible open={open}>
                <div className="border-t border-line/70 px-3 py-2.5">
                    <BlockList blocks={blocks} />
                </div>
            </Collapsible>
        </div>
    );
}
