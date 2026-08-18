import type { DocType } from './types.js';

export type DetectionVia = 'declared' | 'magic' | 'filename' | 'sniff' | 'fallback';

export interface TypeDetection {
    docType: DocType;
    via: DetectionVia;
    warnings: Array<{ code: string; message: string }>;
}

export interface DetectInput {
    declaredType?: string;
    filename?: string;
    text?: string;
    bytes?: Uint8Array;
}

const KNOWN_TYPES: readonly DocType[] = ['markdown', 'plaintext', 'html', 'pdf', 'image'];

const FILENAME_EXTENSIONS: Array<[RegExp, DocType]> = [
    [/\.(md|markdown|mdx)$/i, 'markdown'],
    [/\.txt$/i, 'plaintext'],
    [/\.(html?|xhtml)$/i, 'html'],
    [/\.pdf$/i, 'pdf'],
    [/\.(png|jpe?g|gif|webp|bmp|svg)$/i, 'image'],
];

/**
 * 类型识别（plan §2.1）：declaredType > magic bytes > 文件名后缀 > 文本嗅探，
 * 全部落空则降级 plaintext + warning。识别与切分解耦：识别出的类型若无
 * 注册的 Splitter，由 pipeline 层降级并记录。
 */
export function detectDocType(input: DetectInput): TypeDetection {
    // 1. Loader 声明的类型（如 HTTP 源已知 .md 后缀）
    if (input.declaredType && KNOWN_TYPES.includes(input.declaredType as DocType)) {
        return { docType: input.declaredType as DocType, via: 'declared', warnings: [] };
    }

    // 2. magic bytes（二进制类型只能靠它；文本类型开头的 ASCII 痕迹也检查）
    const magic = detectByMagic(input.bytes ?? toBytes(input.text));
    if (magic) return { docType: magic, via: 'magic', warnings: [] };

    // 3. 文件名后缀
    if (input.filename) {
        for (const [pattern, docType] of FILENAME_EXTENSIONS) {
            if (pattern.test(input.filename)) {
                return { docType, via: 'filename', warnings: [] };
            }
        }
    }

    // 4. 文本嗅探
    if (input.text !== undefined) {
        const sniffed = sniffText(input.text);
        if (sniffed) return { docType: sniffed, via: 'sniff', warnings: [] };
    }

    return {
        docType: 'plaintext',
        via: 'fallback',
        warnings: [
            {
                code: 'type-detection-fallback',
                message: 'Unable to detect document type; falling back to plaintext splitting',
            },
        ],
    };
}

function toBytes(text?: string): Uint8Array | undefined {
    if (text === undefined) return undefined;
    return new TextEncoder().encode(text.slice(0, 512));
}

function detectByMagic(bytes?: Uint8Array): DocType | undefined {
    if (!bytes || bytes.length === 0) return undefined;

    const startsWith = (prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

    if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
    if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image'; // PNG
    if (startsWith([0xff, 0xd8, 0xff])) return 'image'; // JPEG
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
    return undefined;
}

function sniffText(text: string): DocType | undefined {
    const head = text.slice(0, 2000);

    if (/^\s*%PDF-/.test(head)) return 'pdf';
    if (/^\s*(<!doctype html|<html[\s>])/i.test(head)) return 'html';

    // markdown 特征：ATX header、代码围栏、markdown 链接/列表
    if (/^#{1,6}\s+\S/m.test(head)) return 'markdown';
    if (/^(```|~~~)/m.test(head)) return 'markdown';
    if (/\[[^\]]+\]\([^)]+\)/.test(head) && /^\s*[-*]\s+\S/m.test(head)) return 'markdown';

    return undefined;
}
