import type { DocType, Splitter } from './types.js';
import { MarkdownSplitter } from './splitters/markdown.js';
import { PlaintextSplitter } from './splitters/plaintext.js';

/** 策略分发：Map<DocType, Splitter>。未注册类型的降级由 pipeline 处理。 */
export class SplitterRegistry {
    private readonly splitters = new Map<DocType, Splitter>();

    register(splitter: Splitter): void {
        this.splitters.set(splitter.docType, splitter);
    }

    get(docType: DocType): Splitter | undefined {
        return this.splitters.get(docType);
    }

    has(docType: DocType): boolean {
        return this.splitters.has(docType);
    }

    list(): DocType[] {
        return [...this.splitters.keys()];
    }
}

/** 本期默认注册：markdown + plaintext（决策 D8，PDF/HTML/Image 为后续插件） */
export function createDefaultRegistry(): SplitterRegistry {
    const registry = new SplitterRegistry();
    registry.register(new MarkdownSplitter());
    registry.register(new PlaintextSplitter());
    return registry;
}
