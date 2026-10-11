import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

/** Markdown 渲染（GFM：表格/任务列表/删除线；代码块语法高亮）；样式见 index.css .md-body */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
    return (
        <div className={`md-body ${streaming ? 'stream-cursor' : ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content}
            </ReactMarkdown>
        </div>
    );
}
