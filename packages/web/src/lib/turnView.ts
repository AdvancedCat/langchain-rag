// ============================================================================
// Turn 视图分区（纯函数，供 TurnView 使用；2026-10-11 UX 迭代）：
//
// 以「最后一个活动块」（reasoning/toolcall/subagent）为界：
// - 之前的一切（含工具间的叙述 text）→ process：折叠进「思考与工具调用」
//   聚合区块，按原序渲染（叙述是过程的一部分，不该占据正文篇幅）；
// - 之后的 text → answer：最终答案正文，始终可见。
//
// 流式语义：答案文本流式到达时它就是「最后一个块」，作为正文带光标展示；
// 若其后续接了新的工具调用，则该段文本退居折叠区（与 ChatGPT/Claude 的
// 过程收拢行为一致）。回放重建的 block 序列相同，分区结果确定一致。
// ============================================================================

import type { ChatBlock, TextBlock } from './chatStore';

export interface TurnViewSections {
    /** 折叠区内容：活动块 + 其间穿插的过程叙述，保持原序 */
    process: ChatBlock[];
    /** 最终答案正文（最后一个活动块之后的 text） */
    answer: TextBlock[];
}

export function partitionTurnBlocks(blocks: ChatBlock[]): TurnViewSections {
    let lastActivityIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block && block.kind !== 'text') {
            lastActivityIndex = i;
            break;
        }
    }
    if (lastActivityIndex === -1) {
        return { process: [], answer: blocks.filter((b): b is TextBlock => b.kind === 'text') };
    }
    return {
        process: blocks.slice(0, lastActivityIndex + 1),
        answer: blocks.slice(lastActivityIndex + 1).filter((b): b is TextBlock => b.kind === 'text'),
    };
}

export interface ActivitySummary {
    reasoning: number;
    tools: number;
    subagents: number;
    total: number;
    /** 全部活动块已完成（工具出结果、子代理 finished、思考收口）；叙述 text 不参与 */
    allDone: boolean;
}

export function summarizeActivity(blocks: ChatBlock[]): ActivitySummary {
    let reasoning = 0;
    let tools = 0;
    let subagents = 0;
    let allDone = true;
    for (const block of blocks) {
        switch (block.kind) {
            case 'reasoning':
                reasoning += 1;
                if (!block.done) allDone = false;
                break;
            case 'toolcall':
                tools += 1;
                if (!block.done) allDone = false;
                break;
            case 'subagent':
                subagents += 1;
                if (!block.finished) allDone = false;
                break;
            case 'text':
                break;
        }
    }
    return { reasoning, tools, subagents, total: reasoning + tools + subagents, allDone };
}
