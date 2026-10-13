import { describe, expect, it } from 'vitest';
import type { AguiEvent } from '../types';
import { applyEvents, chatReducer, createChatStore, initialChatState, type IncomingEvent } from '../lib/chatStore';

let seq = 0;
/** 造带游标的事件：游标单调递增，模拟 Redis Stream entry id；timestamp 统一补 0 */
function ev(event: { type: string } & Record<string, unknown>): IncomingEvent {
    seq += 1;
    return { eventId: `1000-${seq}`, event: { timestamp: 0, ...event } as AguiEvent };
}

const RUN_STARTED = (runId: string) => ev({ type: 'RUN_STARTED', threadId: 't1', runId });
const RUN_FINISHED = (runId: string) => ev({ type: 'RUN_FINISHED', threadId: 't1', runId, outcome: { type: 'success' } });

describe('applyEvents 流式归约', () => {
    it('完整 run：思考 → 工具 → 文本 → 快照回填用户消息 → 完成', () => {
        let state = initialChatState('ready');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            ev({ type: 'REASONING_MESSAGE_START', messageId: 'm1', role: 'reasoning' }),
            ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: '先分析' }),
            ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: '问题' }),
            ev({ type: 'REASONING_MESSAGE_END', messageId: 'm1' }),
            ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '答案是 ' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'LangChain' }),
            ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }),
            ev({
                type: 'MESSAGES_SNAPSHOT',
                messages: [
                    { id: 'u1', role: 'user', content: '什么是 LangChain' },
                    { id: 'm1', role: 'assistant', content: '答案是 LangChain' },
                ],
            }),
            RUN_FINISHED('r1'),
        ]);

        expect(state.activeRunId).toBeNull();
        expect(state.turns).toHaveLength(1);
        const turn = state.turns[0]!;
        expect(turn.status).toBe('done');
        expect(turn.userText).toBe('什么是 LangChain');
        expect(turn.blocks).toHaveLength(2);
        expect(turn.blocks[0]).toMatchObject({ kind: 'reasoning', content: '先分析问题', done: true });
        expect(turn.blocks[1]).toMatchObject({ kind: 'text', content: '答案是 LangChain', done: true });
        expect(state.lastEventId).toBe(`1000-${seq}`);
    });

    it('同一 messageId 同时承载 reasoning 与 text（DeepSeek 形态），按 kind 区分', () => {
        let state = initialChatState('ready');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            ev({ type: 'REASONING_MESSAGE_START', messageId: 'same', role: 'reasoning' }),
            ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'same', delta: '思考' }),
            ev({ type: 'TEXT_MESSAGE_START', messageId: 'same', role: 'assistant' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'same', delta: '回答' }),
            RUN_FINISHED('r1'),
        ]);
        const blocks = state.turns[0]!.blocks;
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({ kind: 'reasoning', content: '思考' });
        expect(blocks[1]).toMatchObject({ kind: 'text', content: '回答' });
    });

    it('工具调用：START/ARGS 增量/END/RESULT 聚合到同一卡片', () => {
        let state = initialChatState('ready');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            ev({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search_documentation', parentMessageId: 'm1' }),
            ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"query":' }),
            ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '"向量检索"}' }),
            ev({ type: 'TOOL_CALL_END', toolCallId: 'tc1' }),
            ev({ type: 'TOOL_CALL_RESULT', messageId: 'toolmsg1', toolCallId: 'tc1', content: '命中 4 个 chunk', role: 'tool' }),
            RUN_FINISHED('r1'),
        ]);
        const block = state.turns[0]!.blocks[0]!;
        expect(block).toMatchObject({
            kind: 'toolcall',
            name: 'search_documentation',
            args: '{"query":"向量检索"}',
            result: '命中 4 个 chunk',
            done: true,
        });
    });

    it('工具调用：快照式 ARGS 帧（每帧完整参数）以替换而非拼接收敛', () => {
        let state = initialChatState('ready');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            ev({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search_documentation' }),
            ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"que' }),
            ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"query": "What' }),
            ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"query": "What is LangGraph"}' }),
            RUN_FINISHED('r1'),
        ]);
        expect(state.turns[0]!.blocks[0]).toMatchObject({ kind: 'toolcall', args: '{"query": "What is LangGraph"}' });
    });

    it('子代理：SUBAGENT_STARTED 后，携 subagentRunId 的工具/文本挂入其嵌套 blocks', () => {
        let state = initialChatState('ready');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            // 主代理委派 task（工具卡）
            ev({ type: 'TOOL_CALL_START', toolCallId: 'task1', toolCallName: 'task', parentMessageId: 'm1' }),
            ev({ type: 'SUBAGENT_STARTED', subagentRunId: 'sub-1', name: 'chunk-analyst', parentToolCallId: 'task1' }),
            // 子代理内部消息与工具（携 subagentRunId）
            ev({ type: 'TEXT_MESSAGE_START', messageId: 'submsg', role: 'assistant', subagentRunId: 'sub-1' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'submsg', delta: '分析中', subagentRunId: 'sub-1' }),
            ev({ type: 'TOOL_CALL_START', toolCallId: 'sub-tc', toolCallName: 'read_file', subagentRunId: 'sub-1' }),
            // TOOL_CALL_RESULT 不带 subagentRunId，须按 toolCallId 全局嵌套定位
            ev({ type: 'TOOL_CALL_RESULT', messageId: 'subtoolmsg', toolCallId: 'sub-tc', content: '文件内容', role: 'tool' }),
            ev({ type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-1', outcome: { type: 'success' } }),
            RUN_FINISHED('r1'),
        ]);
        const turn = state.turns[0]!;
        expect(turn.blocks).toHaveLength(2);
        const subagent = turn.blocks[1]!;
        expect(subagent).toMatchObject({ kind: 'subagent', name: 'chunk-analyst', parentToolCallId: 'task1', finished: true });
        if (subagent.kind === 'subagent') {
            expect(subagent.blocks).toHaveLength(2);
            expect(subagent.blocks[0]).toMatchObject({ kind: 'text', content: '分析中' });
            expect(subagent.blocks[1]).toMatchObject({ kind: 'toolcall', name: 'read_file', result: '文件内容', done: true });
        }
    });

    it('幂等去重：同 eventId 重复投递（POST 与 GET 双通道）不产生重复', () => {
        const batch = [RUN_STARTED('r1'), ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' })];
        let state = applyEvents(initialChatState('ready'), batch);
        const duplicated = applyEvents(state, batch);
        expect(duplicated).toBe(state); // 引用相等：全部被去重跳过
        expect(state.turns).toHaveLength(1);
        expect(state.turns[0]!.blocks).toHaveLength(1);
    });

    it('无 eventId 的降级事件透传不去重', () => {
        let state = initialChatState('ready');
        const event: IncomingEvent = { event: { type: 'RUN_STARTED', threadId: 't1', runId: 'r1', timestamp: 0 } };
        state = applyEvents(state, [event, event]);
        expect(state.turns).toHaveLength(1);
    });

    it('回放两个 run：各 Turn 的用户消息由各自 snapshot 回填', () => {
        let state = initialChatState('loading');
        state = applyEvents(state, [
            RUN_STARTED('r1'),
            ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '第一轮回答' }),
            ev({ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: '问题一' }] }),
            RUN_FINISHED('r1'),
            RUN_STARTED('r2'),
            ev({ type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' }),
            ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: '第二轮回答' }),
            ev({
                type: 'MESSAGES_SNAPSHOT',
                messages: [
                    { id: 'u1', role: 'user', content: '问题一' },
                    { id: 'a1', role: 'assistant', content: '第一轮回答' },
                    { id: 'u2', role: 'user', content: '问题二' },
                ],
            }),
            RUN_FINISHED('r2'),
        ]);
        expect(state.phase).toBe('ready');
        expect(state.turns.map((turn) => turn.userText)).toEqual(['问题一', '问题二']);
        expect(state.turns[1]!.blocks[0]).toMatchObject({ kind: 'text', content: '第二轮回答' });
    });

    it('RUN_ERROR：cancelled → 已取消（无 error）；timeout → error', () => {
        let state = applyEvents(initialChatState('ready'), [
            RUN_STARTED('r1'),
            ev({ type: 'RUN_ERROR', message: 'run cancelled', code: 'cancelled' }),
        ]);
        expect(state.turns[0]!.status).toBe('cancelled');
        expect(state.turns[0]!.error).toBeUndefined();
        expect(state.activeRunId).toBeNull();

        state = applyEvents(state, [
            RUN_STARTED('r2'),
            ev({ type: 'RUN_ERROR', message: 'run exceeded timeout', code: 'timeout' }),
        ]);
        expect(state.turns[1]!.status).toBe('error');
        expect(state.turns[1]!.error).toMatchObject({ code: 'timeout' });
    });

    it('乐观发送：optimisticSend 保留 userText，RUN_STARTED 不重建 Turn', () => {
        let state = chatReducer(initialChatState('empty'), { type: 'optimisticSend', runId: 'r9', text: '我的问题' });
        expect(state.activeRunId).toBe('r9');
        state = applyEvents(state, [RUN_STARTED('r9'), RUN_FINISHED('r9')]);
        expect(state.turns).toHaveLength(1);
        expect(state.turns[0]!.userText).toBe('我的问题');
        expect(state.turns[0]!.status).toBe('done');
    });

    it('sendFailed / resolveStaleRun 收口', () => {
        let state = chatReducer(initialChatState('empty'), { type: 'optimisticSend', runId: 'r9', text: '问题' });
        state = chatReducer(state, { type: 'sendFailed', runId: 'r9', error: { code: 'too_many_concurrent', message: '服务繁忙' } });
        expect(state.turns[0]!.status).toBe('error');
        expect(state.activeRunId).toBeNull();

        state = chatReducer(initialChatState('ready'), { type: 'optimisticSend', runId: 'r8', text: '问题' });
        state = chatReducer(state, { type: 'resolveStaleRun' });
        expect(state.turns[0]!.status).toBe('error');
        expect(state.activeRunId).toBeNull();
    });

    it('channel 状态与 loadFailed', () => {
        let state = chatReducer(initialChatState('loading'), { type: 'channel', channel: { state: 'reconnecting', attempt: 2 } });
        expect(state.channel).toEqual({ state: 'reconnecting', attempt: 2 });
        state = chatReducer(state, { type: 'loadFailed', error: { message: '网络错误' } });
        expect(state.phase).toBe('error');
        expect(state.loadError).toEqual({ message: '网络错误' });
    });

    it('CUSTOM retrieval.trace 记录到当前 Turn', () => {
        let state = applyEvents(initialChatState('ready'), [
            RUN_STARTED('r1'),
            ev({
                type: 'CUSTOM',
                name: 'retrieval.trace',
                value: { gate: { decision: 'PASS' }, chunks: [{ path: '/retrieved/x/chunk_1.md' }] },
            }),
            RUN_FINISHED('r1'),
        ]);
        expect(state.turns[0]!.trace).toMatchObject({ gate: { decision: 'PASS' } });
    });

    it('CUSTOM cozeloop.trace 记录 traceId 到当前 Turn（run 进行中即可见）', () => {
        const state = applyEvents(initialChatState('ready'), [
            RUN_STARTED('r2'),
            ev({
                type: 'CUSTOM',
                name: 'cozeloop.trace',
                value: { traceId: '559e036504609eeef09ddf420ab055fc', runId: 'r2' },
            }),
        ]);
        expect(state.turns[0]!.traceId).toBe('559e036504609eeef09ddf420ab055fc');
    });

    it('回放顺序（RUN_STARTED 之后）保证 traceId 落在本轮 Turn', () => {
        let state = applyEvents(initialChatState('ready'), [
            RUN_STARTED('r1'),
            RUN_FINISHED('r1'),
            RUN_STARTED('r2'),
            ev({ type: 'CUSTOM', name: 'cozeloop.trace', value: { traceId: 'aaaa1111bbbb2222cccc3333dddd4444' } }),
            RUN_FINISHED('r2'),
        ]);
        expect(state.turns[0]!.traceId).toBeUndefined();
        expect(state.turns[1]!.traceId).toBe('aaaa1111bbbb2222cccc3333dddd4444');
    });

    it('未知 CUSTOM name 与缺失 traceId 的载荷被忽略', () => {
        const state = applyEvents(initialChatState('ready'), [
            RUN_STARTED('r1'),
            ev({ type: 'CUSTOM', name: 'something.else', value: { traceId: 'x' } }),
            ev({ type: 'CUSTOM', name: 'cozeloop.trace', value: {} }),
            RUN_FINISHED('r1'),
        ]);
        expect(state.turns[0]!.traceId).toBeUndefined();
    });
});

describe('createChatStore', () => {
    it('dispatch 触发订阅、无变化不通知', () => {
        const store = createChatStore();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => {
            notifications += 1;
        });
        store.dispatch({ type: 'channel', channel: { state: 'ok' } }); // 与初值相同，不通知
        expect(notifications).toBe(0);
        store.dispatch({ type: 'reset', phase: 'empty' });
        expect(notifications).toBe(1);
        expect(store.getState().phase).toBe('empty');
        unsubscribe();
        store.dispatch({ type: 'reset', phase: 'loading' });
        expect(notifications).toBe(1);
    });
});
