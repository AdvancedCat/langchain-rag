// ============================================================================
// fetch-SSE 读取器（设计决策 F1）：统一解析 POST /agui 与 GET /threads/:id/events
// 两条通道。帧格式（@ag-ui/encoder encodeSSE + api 包 sse.ts）：
//
//   [id: <Redis entry id>\n]data: <事件 JSON>\n\n     ← 仅 data: 行，无 event: 行
//   : ka\n\n                                           ← 15s 心跳注释行，必须容忍
//
// 不用 EventSource：无法 POST、无法带查询参数、重连行为不可控；
// 不用 @ag-ui/client：attach 游标/去重/409 降级为自有扩展（见 frontend-plan.md §4 F1）。
// ============================================================================

import type { AguiEvent } from '../types';

export interface SseMessage {
    /** Redis Stream entry id（续传游标）；降级事件无 id */
    eventId?: string;
    data: string;
}

/**
 * 增量 SSE 帧解析器。任意切分的文本块都可喂入 push()，
 * 完整帧（空行分隔）才会被返回；跨块半包安全。
 */
export class SseFrameParser {
    private buffer = '';
    private dataLines: string[] = [];
    private pendingEventId: string | undefined;

    push(chunk: string): SseMessage[] {
        this.buffer += chunk;
        const frames: SseMessage[] = [];
        // 兼容 \r\n 与 \n
        let newlineIndex = findNewline(this.buffer);
        while (newlineIndex !== -1) {
            const line = this.buffer.slice(0, newlineIndex.index);
            this.buffer = this.buffer.slice(newlineIndex.index + newlineIndex.length);
            this.processLine(line, frames);
            newlineIndex = findNewline(this.buffer);
        }
        return frames;
    }

    /** 流结束时冲刷未以空行收尾的残帧（防御性：服务端正常都以 \n\n 结帧） */
    flush(): SseMessage[] {
        const line = this.buffer;
        this.buffer = '';
        const frames: SseMessage[] = [];
        this.processLine(line, frames);
        if (this.dataLines.length > 0) {
            frames.push(this.frame());
        }
        return frames;
    }

    private processLine(line: string, frames: SseMessage[]): void {
        if (line === '') {
            // 空行 = 帧边界；无 data 行的空帧（如心跳后的空行）忽略
            if (this.dataLines.length > 0) {
                frames.push(this.frame());
            }
            return;
        }
        if (line.startsWith(':')) return; // 注释/心跳
        if (line.startsWith('data:')) {
            this.dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('id:')) {
            const id = line.slice(3).replace(/^ /, '');
            this.pendingEventId = id === '' ? undefined : id;
        }
        // event:/retry: 等其余字段本服务不使用，忽略
    }

    private frame(): SseMessage {
        const message: SseMessage = { data: this.dataLines.join('\n') };
        if (this.pendingEventId !== undefined) {
            message.eventId = this.pendingEventId;
            this.pendingEventId = undefined;
        }
        this.dataLines = [];
        return message;
    }
}

function findNewline(text: string): { index: number; length: number } | -1 {
    const lf = text.indexOf('\n');
    if (lf === -1) return -1;
    if (lf > 0 && text[lf - 1] === '\r') return { index: lf - 1, length: 2 };
    return { index: lf, length: 1 };
}

/** data JSON → AguiEvent；无法解析或形状不对则返回 undefined（容错前向兼容） */
export function parseAguiEvent(data: string): AguiEvent | undefined {
    try {
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
            return parsed as AguiEvent;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export interface ReadSseOptions {
    signal?: AbortSignal;
    onMessage: (message: SseMessage) => void;
}

/** 读取 fetch 响应体中的 SSE 流直至自然结束或 abort */
export async function readSseStream(body: ReadableStream<Uint8Array>, options: ReadSseOptions): Promise<void> {
    const parser = new SseFrameParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
                options.onMessage(frame);
                if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            }
        }
        const tail = decoder.decode();
        if (tail) {
            for (const frame of parser.push(tail)) options.onMessage(frame);
        }
        for (const frame of parser.flush()) options.onMessage(frame);
    } finally {
        reader.releaseLock();
    }
}
