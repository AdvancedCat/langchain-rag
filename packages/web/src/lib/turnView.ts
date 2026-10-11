// ============================================================================
// Turn 视图分区（纯函数，供 TurnView 使用；联调 UX 迭代 2026-10-11）：
// 一个 Turn 的 blocks 分为「执行过程」（reasoning/toolcall/subagent，折叠进
// 单个聚合区块）与「正文」（text，含中间叙述与最终答案，始终可见）。
// 分区不保交织顺序——两类各自保序；渲染上聚合块在正文之前。
// ============================================================================

import type { ChatBlock, TextBlock } from './chatStore';

export interface TurnViewSections {
    activity: ChatBlock[];
    texts: TextBlock[];
}

export function partitionTurnBlocks(blocks: ChatBlock[]): TurnViewSections {
    const activity: ChatBlock[] = [];
    const texts: TextBlock[] = [];
    for (const block of blocks) {
        if (block.kind === 'text') texts.push(block);
        else activity.push(block);
    }
    return { activity, texts };
}

export interface ActivitySummary {
    reasoning: number;
    tools: number;
    subagents: number;
    total: number;
    /** 全部活动块已完成（工具出结果、子代理 finished、思考收口） */
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
        }
    }
    return { reasoning, tools, subagents, total: blocks.length, allDone };
}
