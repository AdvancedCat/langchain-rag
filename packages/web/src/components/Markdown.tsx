import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Link2 } from 'lucide-react';
import 'highlight.js/styles/github-dark.css';
import { parseSourceLink } from '../lib/sourceLink';
import { useCopy } from '../hooks';
import { IconCheck, IconCopy } from './icons';

/** hast 节点最小结构（@types/hast 为传递依赖不直接引用） */
interface HastNodeLike {
    type: string;
    value?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HastNodeLike[];
}

/** 递归提取 hast 子树纯文本（代码块高亮后是嵌套 span，原始文本散在 text 节点里） */
function hastTextDeep(node: HastNodeLike | undefined): string {
    if (!node) return '';
    if (node.type === 'text') return node.value ?? '';
    return (node.children ?? []).map(hastTextDeep).join('');
}

/**
 * 代码块工具条（MASTER §7）：右上角语言标签（11px）+ 复制按钮，hover/focus 显现；
 * 复制走 §7 通用反馈模式（check 图标，≤1.6s 回退，控件尺寸不变）。
 * 色彩用深岛 token：代码块恒定 zinc-900 深底，两主题一致。
 */
function CodeBlock({ lang, raw, children }: { lang: string | null; raw: string; children: ReactNode }) {
    const { copied, copy } = useCopy();
    return (
        <div className="group/code relative">
            {children}
            <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover/code:opacity-100">
                {lang && (
                    <span className="rounded bg-code-chip px-1.5 py-1 font-mono text-[11px] leading-none text-code-muted">
                        {lang}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => copy(raw)}
                    title={copied ? '已复制' : '复制代码'}
                    aria-label={copied ? '已复制' : '复制代码'}
                    className="flex h-6 w-6 items-center justify-center rounded bg-code-chip text-code-muted transition-colors hover:bg-code-chip-hover hover:text-code-bright"
                >
                    {copied ? <IconCheck className="h-3.5 w-3.5 text-code-bright" /> : <IconCopy />}
                    {copied && <span className="sr-only">已复制</span>}
                </button>
            </div>
        </div>
    );
}

/** 来源徽标内的小链接图标 */
function LinkIcon() {
    return (
        <Link2 aria-hidden strokeWidth={1.6} className="h-3 w-3 shrink-0 opacity-60" />
    );
}

/** 提取 hast 元素的纯文本（a 节点的子级是 text） */
function hastText(node: HastNodeLike | undefined): string {
    if (!node?.children) return '';
    return node.children
        .map((child) => (child.type === 'text' ? (child.value ?? '') : ''))
        .join('');
}

/** Markdown 渲染（GFM；代码块语法高亮；URL 形态的来源链接转徽标）；样式见 index.css .md-body */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
    return (
        <div className={`md-body ${streaming ? 'stream-cursor' : ''}`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    pre({ node, children }) {
                        const code = (node as HastNodeLike | undefined)?.children?.find(
                            (child) => child.tagName === 'code',
                        );
                        const classes = Array.isArray(code?.properties?.className)
                            ? (code?.properties?.className as string[])
                            : [];
                        const lang = classes.find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? null;
                        return (
                            <CodeBlock lang={lang} raw={hastTextDeep(code)}>
                                {children}
                            </CodeBlock>
                        );
                    },
                    a({ node, href, children }) {
                        const hrefStr = typeof href === 'string' ? href : '';
                        const source = parseSourceLink(hrefStr, hastText(node as HastNodeLike | undefined));
                        if (source.isSource) {
                            return (
                                <>
                                    <a className="source-chip" href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
                                        <LinkIcon />
                                        <span className="source-host">{source.host}</span>
                                        <span className="source-path">{source.pathLabel}</span>
                                    </a>
                                    {source.note && <span>{source.note}</span>}
                                </>
                            );
                        }
                        return (
                            <a href={hrefStr} target="_blank" rel="noopener noreferrer">
                                {children}
                            </a>
                        );
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
