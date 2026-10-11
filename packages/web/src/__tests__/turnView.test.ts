import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '../lib/chatStore';
import { partitionTurnBlocks, summarizeActivity } from '../lib/turnView';

const reasoning = (done = true): ChatBlock => ({ kind: 'reasoning', messageId: 'r1', content: '想', done });
const text = (id = 't1', done = true): ChatBlock => ({ kind: 'text', messageId: id, content: '答', done });
const tool = (done = true): ChatBlock => ({ kind: 'toolcall', toolCallId: 'c1', name: 'search_documentation', args: '{}', result: done ? 'r' : null, done });
const subagent = (finished = true): ChatBlock => ({
    kind: 'subagent', subagentRunId: 's1', name: 'chunk-analyst', parentToolCallId: 'c2', finished, blocks: [],
});

describe('partitionTurnBlocks', () => {
    it('最后一个活动块之前的叙述 text 收进 process，其后的是 answer', () => {
        const { process, answer } = partitionTurnBlocks([
            reasoning(),
            text('narration-1'),
            tool(),
            text('narration-2'),
            subagent(),
            text('answer-1'),
            text('answer-2'),
        ]);
        expect(process.map((b) => b.kind)).toEqual(['reasoning', 'text', 'toolcall', 'text', 'subagent']);
        expect(process.some((b) => b.kind === 'text' && b.messageId === 'narration-1')).toBe(true);
        expect(answer.map((b) => (b.kind === 'text' ? b.messageId : ''))).toEqual(['answer-1', 'answer-2']);
    });

    it('纯正文 Turn（无活动块）：全部为 answer', () => {
        const { process, answer } = partitionTurnBlocks([text('a'), text('b')]);
        expect(process).toHaveLength(0);
        expect(answer).toHaveLength(2);
    });

    it('活动块结尾、答案未开始（流式中）：answer 为空', () => {
        const { process, answer } = partitionTurnBlocks([reasoning(), tool()]);
        expect(process).toHaveLength(2);
        expect(answer).toHaveLength(0);
    });

    it('空 blocks', () => {
        const { process, answer } = partitionTurnBlocks([]);
        expect(process).toHaveLength(0);
        expect(answer).toHaveLength(0);
    });
});

describe('summarizeActivity', () => {
    it('分类计数，叙述 text 不计数不参与 allDone', () => {
        const summary = summarizeActivity([reasoning(), text(), tool(), subagent(), tool(false), text('n2')]);
        expect(summary).toMatchObject({ reasoning: 1, tools: 2, subagents: 1, total: 4, allDone: false });
    });

    it('全部完成时 allDone=true', () => {
        expect(summarizeActivity([reasoning(), tool(), subagent()]).allDone).toBe(true);
        expect(summarizeActivity([reasoning(false)]).allDone).toBe(false);
        expect(summarizeActivity([subagent(false)]).allDone).toBe(false);
    });

    it('空活动', () => {
        expect(summarizeActivity([])).toMatchObject({ reasoning: 0, tools: 0, subagents: 0, total: 0, allDone: true });
    });
});
