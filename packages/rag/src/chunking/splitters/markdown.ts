import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { SplitOptions, Splitter, SplitterChunk, SplitDocInput, SplitWarning } from '../types.js';

interface Header {
    level: number;
    text: string;
    lineIndex: number;
}

interface Section {
    /** h1..hN 的标题栈，如 ["Agents", "Tools", "Custom tools"]；无 header 文档为 [] */
    path: string[];
    content: string;
}

/**
 * Markdown header 切分核（自研，决策 D7：JS 版 @langchain/textsplitters 无
 * MarkdownHeaderTextSplitter，F1）。
 *
 * 行为：
 * - 扫描 h1-h4 ATX header（`# Title`），跳过代码围栏（``` / ~~~）内的 `#`；
 * - 每个 header 开启一个 section，content 为去 header 行后的正文；
 * - 超过 chunkSize 的 section 用 RecursiveCharacterTextSplitter 二级切，
 *   子块共享该 section 的 sectionPath；
 * - 无 header 的文档整体作单 section（sectionPath 为空）。
 */
export class MarkdownSplitter implements Splitter {
    readonly docType = 'markdown' as const;

    async split(
        input: SplitDocInput,
        options: SplitOptions,
    ): Promise<{ chunks: SplitterChunk[]; warnings: SplitWarning[] }> {
        const warnings: SplitWarning[] = [];
        const lines = input.text.split('\n');
        const headers = scanHeaders(lines, options.maxHeaderDepth);

        const title = headers.find((h) => h.level === 1)?.text;

        const sections = splitSections(lines, headers);

        const chunks: SplitterChunk[] = [];
        for (const section of sections) {
            if (section.content.length <= options.chunkSize) {
                chunks.push(this.toChunk(section, title));
                continue;
            }
            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: options.chunkSize,
                chunkOverlap: options.chunkOverlap,
            });
            const pieces = await splitter.splitText(section.content);
            for (const piece of pieces) {
                if (piece.trim().length === 0) continue;
                chunks.push(this.toChunk({ path: section.path, content: piece }, title));
            }
        }

        return { chunks, warnings };
    }

    private toChunk(section: Section, title?: string): SplitterChunk {
        return {
            content: section.content,
            metadata: {
                ...(section.path.length > 0 ? { sectionPath: section.path } : {}),
                ...(title !== undefined ? { title } : {}),
            },
        };
    }
}

/** 只认 ATX header（`#` 前缀），h5/h6 视为普通文本；围栏内的 # 不算 header */
export function scanHeaders(lines: string[], maxDepth: number): Header[] {
    const headers: Header[] = [];
    let fenceMarker: string | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fence) {
            const marker = fence[1];
            if (fenceMarker === null) {
                fenceMarker = marker[0].repeat(3);
            } else if (marker[0] === fenceMarker[0]) {
                fenceMarker = null;
            }
            continue;
        }
        if (fenceMarker !== null) continue;

        const header = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (header && header[1].length <= maxDepth) {
            headers.push({
                level: header[1].length,
                text: header[2].trim(),
                lineIndex: i,
            });
        }
    }

    return headers;
}

/** 按 header 边界切 section；首个 header 之前的前言为 path=[] 的 section */
export function splitSections(lines: string[], headers: Header[]): Section[] {
    const sections: Section[] = [];

    const preambleEnd = headers.length > 0 ? headers[0].lineIndex : lines.length;
    const preamble = lines.slice(0, preambleEnd).join('\n').trim();
    if (preamble) sections.push({ path: [], content: preamble });

    const stack: Header[] = [];
    for (let h = 0; h < headers.length; h++) {
        const header = headers[h];
        while (stack.length > 0 && stack[stack.length - 1].level >= header.level) {
            stack.pop();
        }
        stack.push(header);

        const bodyStart = header.lineIndex + 1;
        const bodyEnd = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
        const content = lines.slice(bodyStart, bodyEnd).join('\n').trim();
        if (!content) continue;

        sections.push({ path: stack.map((s) => s.text), content });
    }

    return sections;
}
