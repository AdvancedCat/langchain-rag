import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { parseSourceLink } from '../lib/sourceLink';

/** hast 节点最小结构（@types/hast 为传递依赖不直接引用） */
interface HastNodeLike {
    type: string;
    value?: string;
    children?: HastNodeLike[];
}

/** 来源徽标内的小链接图标 */
function LinkIcon() {
    return (
        <svg aria-hidden="true" className="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6.5 9.5l3-3M5 7.5L3.7 8.8a2.4 2.4 0 0 0 3.4 3.4L8.4 11M11 8.5l1.3-1.3a2.4 2.4 0 0 0-3.4-3.4L7.6 5" strokeLinecap="round" />
        </svg>
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
