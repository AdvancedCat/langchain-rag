import { describe, it, expect } from 'vitest';
import { MarkdownSplitter, scanHeaders, splitSections } from '../markdown.js';
import type { SplitDocInput, SplitOptions } from '../../types.js';

const OPTIONS: SplitOptions = { chunkSize: 100, chunkOverlap: 10, maxHeaderDepth: 4 };

const DOC: SplitDocInput = {
    text: [
        '# Agents',           // 0
        'Intro to agents.',   // 1
        '',                   // 2
        '## Tools',           // 3
        'Tools intro.',       // 4
        '',                   // 5
        '### Custom tools',   // 6
        'Custom tool body.',  // 7
    ].join('\n'),
    docId: 'https://docs.langchain.com/agents',
    source: 'https://docs.langchain.com/agents',
};

describe('scanHeaders', () => {
    it('collects h1-h4 with level, text and line position', () => {
        const headers = scanHeaders(DOC.text.split('\n'), 4);
        expect(headers).toEqual([
            { level: 1, text: 'Agents', lineIndex: 0 },
            { level: 2, text: 'Tools', lineIndex: 3 },
            { level: 3, text: 'Custom tools', lineIndex: 6 },
        ]);
    });

    it('ignores # inside code fences (``` and ~~~)', () => {
        const lines = [
            '# Real header',
            '```python',
            '# this is a python comment, not a header',
            'x = 1',
            '```',
            '~~~md',
            '# fenced inside tilde block',
            '~~~',
            '## Second',
        ];
        const headers = scanHeaders(lines, 4);
        expect(headers.map((h) => h.text)).toEqual(['Real header', 'Second']);
    });

    it('treats an unclosed fence conservatively (no headers after it)', () => {
        const lines = ['# Real', '```', '# inside', '# still inside'];
        expect(scanHeaders(lines, 4).map((h) => h.text)).toEqual(['Real']);
    });

    it('ignores h5/h6 beyond maxHeaderDepth', () => {
        const lines = ['# H1', '##### H5'];
        expect(scanHeaders(lines, 4).map((h) => h.text)).toEqual(['H1']);
    });

    it('ignores # without trailing text and trailing closing sequences', () => {
        const headers = scanHeaders(['## Closed ##', '##', ' #not-a-header'], 4);
        expect(headers).toEqual([{ level: 2, text: 'Closed', lineIndex: 0 }]);
    });
});

describe('splitSections', () => {
    it('maintains the header stack across levels', () => {
        const lines = DOC.text.split('\n');
        const sections = splitSections(lines, scanHeaders(lines, 4));
        expect(sections).toEqual([
            { path: ['Agents'], content: 'Intro to agents.' },
            { path: ['Agents', 'Tools'], content: 'Tools intro.' },
            { path: ['Agents', 'Tools', 'Custom tools'], content: 'Custom tool body.' },
        ]);
    });

    it('keeps the preamble before the first header as an empty-path section', () => {
        const lines = ['Preamble text.', '', '# H1', 'Body.'];
        const sections = splitSections(lines, scanHeaders(lines, 4));
        expect(sections[0]).toEqual({ path: [], content: 'Preamble text.' });
        expect(sections[1]).toEqual({ path: ['H1'], content: 'Body.' });
    });

    it('returns the whole document as one empty-path section when no headers exist', () => {
        const lines = ['just', 'plain', 'lines'];
        const sections = splitSections(lines, scanHeaders(lines, 4));
        expect(sections).toEqual([{ path: [], content: 'just\nplain\nlines' }]);
    });

    it('skips headers whose body is empty (header-only skeleton)', () => {
        const lines = ['# H1', '## H2', 'body'];
        const sections = splitSections(lines, scanHeaders(lines, 4));
        expect(sections).toEqual([{ path: ['H1', 'H2'], content: 'body' }]);
    });

    it('pops the stack when returning to a shallower level', () => {
        const lines = ['# A', '## B', 'b body', '# C', 'c body'];
        const sections = splitSections(lines, scanHeaders(lines, 4));
        expect(sections.map((s) => s.path)).toEqual([['A', 'B'], ['C']]);
    });
});

describe('MarkdownSplitter.split', () => {
    it('emits one chunk per short section with sectionPath and title', async () => {
        const { chunks, warnings } = await new MarkdownSplitter().split(DOC, OPTIONS);
        expect(warnings).toEqual([]);
        expect(chunks.map((c) => c.metadata.sectionPath)).toEqual([
            ['Agents'],
            ['Agents', 'Tools'],
            ['Agents', 'Tools', 'Custom tools'],
        ]);
        expect(chunks.every((c) => c.metadata.title === 'Agents')).toBe(true);
        expect(chunks[0].content).toBe('Intro to agents.');
    });

    it('re-splits oversized sections with the character splitter, sharing sectionPath', async () => {
        const longBody = 'word '.repeat(60); // ~300 chars > chunkSize 100
        const input: SplitDocInput = {
            text: `# T\n\n## Sub\n\n${longBody}`,
            docId: 'https://x.test/doc',
            source: 'https://x.test/doc',
        };
        const { chunks } = await new MarkdownSplitter().split(input, OPTIONS);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.metadata.sectionPath).toEqual(['T', 'Sub']);
            expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.chunkSize);
        }
    });

    it('degrades to a single section for header-less documents', async () => {
        const input: SplitDocInput = {
            text: 'no headers here\njust text',
            docId: 'https://x.test/doc',
            source: 'https://x.test/doc',
        };
        const { chunks } = await new MarkdownSplitter().split(input, {
            ...OPTIONS,
            chunkSize: 1000,
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].metadata.sectionPath).toBeUndefined();
        expect(chunks[0].metadata.title).toBeUndefined();
    });

    it('is deterministic: same input produces identical output', async () => {
        const splitter = new MarkdownSplitter();
        const first = await splitter.split(DOC, OPTIONS);
        const second = await splitter.split(DOC, OPTIONS);
        expect(first).toEqual(second);
    });
});
