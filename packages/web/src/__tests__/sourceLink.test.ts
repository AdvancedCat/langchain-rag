import { describe, expect, it } from 'vitest';
import { parseSourceLink } from '../lib/sourceLink';

describe('parseSourceLink', () => {
    it('链接文本为 URL 本身 → 来源徽标（host 用已知站点名，长路径取末两级加 …/）', () => {
        const info = parseSourceLink(
            'https://docs.langchain.com/oss/javascript/langchain/messages',
            'https://docs.langchain.com/oss/javascript/langchain/messages',
        );
        expect(info).toEqual({
            isSource: true,
            url: 'https://docs.langchain.com/oss/javascript/langchain/messages',
            host: 'LangChain Docs',
            pathLabel: '…/langchain / messages',
            note: '',
        });
    });

    it('括号注释被吞进 href（原始中文形态）→ 切割还原真实 URL，note 为完整注释', () => {
        const info = parseSourceLink(
            'https://docs.langchain.com/oss/javascript/langchain/messages（Message content / Standard content blocks）',
            'https://docs.langchain.com/oss/javascript/langchain/messages（Message content / Standard content blocks）',
        );
        expect(info.isSource).toBe(true);
        expect(info.url).toBe('https://docs.langchain.com/oss/javascript/langchain/messages');
        expect(info.pathLabel).toBe('…/langchain / messages');
        expect(info.note).toBe('（Message content / Standard content blocks）');
    });

    it('autolink 在空格处截断（真实 DOM 形态）→ note 为被吞的注释前缀', () => {
        const info = parseSourceLink(
            'https://docs.langchain.com/oss/javascript/langchain/messages（Message',
            'https://docs.langchain.com/oss/javascript/langchain/messages（Message',
        );
        expect(info.isSource).toBe(true);
        expect(info.url).toBe('https://docs.langchain.com/oss/javascript/langchain/messages');
        expect(info.note).toBe('（Message');
    });

    it('括号注释被吞进 href（react-markdown 百分号编码形态）→ 解码后同样识别', () => {
        const href = 'https://docs.langchain.com/oss/python/deepagents/tools%EF%BC%88%E5%A4%9A%E6%A8%A1%E6%80%81%E5%B7%A5%E5%85%B7%E8%BE%93%E5%87%BA%EF%BC%89';
        const info = parseSourceLink(href, 'https://docs.langchain.com/oss/python/deepagents/tools（多模态工具输出）');
        expect(info.isSource).toBe(true);
        expect(info.url).toBe('https://docs.langchain.com/oss/python/deepagents/tools');
        expect(info.pathLabel).toBe('…/deepagents / tools');
        expect(info.note).toBe('（多模态工具输出）');
    });

    it('路径两级以内直接展示', () => {
        const info = parseSourceLink('https://github.com/langchain-ai/docs', 'https://github.com/langchain-ai/docs');
        expect(info).toEqual({
            isSource: true,
            url: 'https://github.com/langchain-ai/docs',
            host: 'GitHub',
            pathLabel: 'langchain-ai / docs',
            note: '',
        });
    });

    it('未知站点去 www 前缀', () => {
        const info = parseSourceLink('https://www.example.com/a/b', 'https://www.example.com/a/b');
        expect(info).toEqual({ isSource: true, url: 'https://www.example.com/a/b', host: 'example.com', pathLabel: 'a / b', note: '' });
    });

    it('普通文字链接不是来源', () => {
        const info = parseSourceLink('https://docs.langchain.com/oss/javascript/langchain/messages', 'messages 文档');
        expect(info.isSource).toBe(false);
    });

    it('非 http(s) 或非法 href 不是来源', () => {
        expect(parseSourceLink('mailto:a@b.c', 'mailto:a@b.c').isSource).toBe(false);
        expect(parseSourceLink('not-a-url', 'not-a-url').isSource).toBe(false);
        expect(parseSourceLink('', 'anything').isSource).toBe(false);
    });

    it('URL 前后差异容忍：结尾标点与尾部斜杠', () => {
        expect(parseSourceLink('https://example.com/x/y/', 'https://example.com/x/y.').isSource).toBe(true);
    });
});
