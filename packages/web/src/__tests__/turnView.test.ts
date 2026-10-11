import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '../lib/chatStore';
import { partitionTurnBlocks, summarizeActivity } from '../lib/turnView';

const reasoning = (done = true): ChatBlock => ({ kind: 'reasoning', messageId: 'r1', content: '想', done });
const text = (done = true): ChatBlock => ({ kind: 'text', messageId: 't1', content: '答', done });
const tool = (done = true): ChatBlock => ({ kind: 'toolcall', toolCallId: 'c1', name: 'search_documentation', args: '{}', result: done ? 'r' : null, done });
const subagent = (finished = true): ChatBlock => ({
    kind: 'subagent', subagentRunId: 's1', name: 'chunk-analyst', parentToolCallId: 'c2', finished, blocks: [],
});

describe('partitionTurnBlocks', () => {
    it('活动块与正文分离，各自保序', () => {
        const { activity, texts } = partitionTurnBlocks([reasoning(), text(), tool(), text(), subagent()]);
        expect(activity.map((b) => b.kind)).toEqual(['reasoning', 'toolcall', 'subagent']);
        expect(texts).toHaveLength(2);
    });

    it('纯正文 Turn 无活动块', () => {
        const { activity, texts } = partitionTurnBlocks([text(), text()]);
        expect(activity).toHaveLength(0);
        expect(texts).toHaveLength(2);
    });

    it('空 blocks', () => {
        const { activity, texts } = partitionTurnBlocks([]);
        expect(activity).toHaveLength(0);
        expect(texts).toHaveLength(0);
    });
});

describe('summarizeActivity', () => {
    it('分类计数与 allDone', () => {
        const summary = summarizeActivity([reasoning(), tool(), subagent(), tool(false)]);
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
