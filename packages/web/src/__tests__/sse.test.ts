import { describe, expect, it } from 'vitest';
import { SseFrameParser, parseAguiEvent, readSseStream, type SseMessage } from '../lib/sse';

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('SseFrameParser', () => {
    it('解析带 id 的标准帧', () => {
        const parser = new SseFrameParser();
        expect(parser.push('id: 1728541234567-3\ndata: {"type":"RUN_STARTED"}\n\n')).toEqual([
            { eventId: '1728541234567-3', data: '{"type":"RUN_STARTED"}' },
        ]);
    });

    it('容忍心跳注释行与无 data 的空帧', () => {
        const parser = new SseFrameParser();
        const frames = parser.push(': ka\n\nid: 1-0\ndata: {}\n\n: ka\n\n');
        expect(frames).toEqual([{ eventId: '1-0', data: '{}' }]);
    });

    it('跨块半包安全：一行从中间断开', () => {
        const parser = new SseFrameParser();
        expect(parser.push('id: 5-1\nda')).toEqual([]);
        expect(parser.push('ta: {"a":1}\n')).toEqual([]);
        expect(parser.push('\n')).toEqual([{ eventId: '5-1', data: '{"a":1}' }]);
    });

    it('多 data 行按规范拼接为 \\n', () => {
        const parser = new SseFrameParser();
        expect(parser.push('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }]);
    });

    it('兼容 CRLF 行尾', () => {
        const parser = new SseFrameParser();
        expect(parser.push('id: 9-9\r\ndata: x\r\n\r\n')).toEqual([{ eventId: '9-9', data: 'x' }]);
    });

    it('id 只作用于下一帧（帧后复位）', () => {
        const parser = new SseFrameParser();
        const frames = parser.push('id: 1-0\ndata: a\n\ndata: b\n\n');
        expect(frames).toEqual([
            { eventId: '1-0', data: 'a' },
            { data: 'b' },
        ]);
    });

    it('flush 冲刷未以空行收尾的残帧', () => {
        const parser = new SseFrameParser();
        parser.push('data: tail');
        expect(parser.flush()).toEqual([{ data: 'tail' }]);
        expect(parser.flush()).toEqual([]);
    });

    it('data: 后无空格与前缀空格均可', () => {
        const parser = new SseFrameParser();
        const frames = parser.push('data:nospace\ndata: with space\n\n');
        expect(frames).toEqual([{ data: 'nospace\nwith space' }]);
    });
});

describe('parseAguiEvent', () => {
    it('解析合法事件', () => {
        const event = parseAguiEvent('{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"你好"}');
        expect(event).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' });
    });

    it('非法 JSON 或缺 type 返回 undefined', () => {
        expect(parseAguiEvent('not json')).toBeUndefined();
        expect(parseAguiEvent('{"foo":1}')).toBeUndefined();
        expect(parseAguiEvent('null')).toBeUndefined();
    });
});

describe('readSseStream', () => {
    it('按序读出全部帧并容忍心跳', async () => {
        const messages: SseMessage[] = [];
        await readSseStream(await sseResponse([': ka\n\nid: 1-0\ndata: {"type":"RUN_STARTED"}\n\n', 'id: 1-1\ndata: {"type":"RUN_FINISHED"}\n\n']).body!, {
            onMessage: (message) => messages.push(message),
        });
        expect(messages).toEqual([
            { eventId: '1-0', data: '{"type":"RUN_STARTED"}' },
            { eventId: '1-1', data: '{"type":"RUN_FINISHED"}' },
        ]);
    });
});
