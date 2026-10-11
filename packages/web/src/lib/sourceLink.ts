// ============================================================================
// 来源链接识别与标签派生（纯函数，供 Markdown 的 a 渲染器使用）：
// agent 的「来源」列表把原始 URL 直接作为链接文本（retrieval.trace 结构化
// 数据是 M9-P3 项，当前不可用），渲染时将其转为紧凑徽标：站点名 + 路径摘要，
// 完整 URL 走 title 悬停。正文中的普通文字链接不受影响。
//
// 两个已知污染形态（GFM autolink 到非空格字符所致）：
// 1. 括号注释被吞进链接：href/text 形如 "https://…/messages（Message content…）"，
//    且 react-markdown 会对 href 做百分号编码——比较与解析前先解码，并在
//    第一个全角/半角左括号处切割还原真实 URL（文档站路径不含括号，可接受）；
// 2. 链接文本尾部带标点/尾注，比较前统一修剪。
// ============================================================================

export interface SourceLinkInfo {
    /** 链接文本本身就是 URL（来源引用形态） */
    isSource: boolean;
    /** 切割注释后还原的真实 URL（用作跳转地址与悬停提示） */
    url: string;
    /** 站点显示名：docs.langchain.com → LangChain Docs，其余去 www */
    host: string;
    /** 路径摘要：末两级段，超出部分以 …/ 前缀示意 */
    pathLabel: string;
    /** 链接文本中被 URL 吞掉的注释片段（autolink 在空格处截断所致，
     *  如 "（Message"）——渲染时拼回徽标之后，使其与后续兄弟文本衔接 */
    note: string;
}

const KNOWN_SITES: Record<string, string> = {
    'docs.langchain.com': 'LangChain Docs',
    'reference.langchain.com': 'LangChain Reference',
    'github.com': 'GitHub',
};

function tryDecode(s: string): string {
    try {
        return decodeURI(s);
    } catch {
        return s;
    }
}

const emptyInfo: SourceLinkInfo = { isSource: false, url: '', host: '', pathLabel: '', note: '' };

export function parseSourceLink(href: string, linkText: string): SourceLinkInfo {
    if (!href) return emptyInfo;
    const raw = href.trim();
    if (!/^https?:\/\//i.test(raw)) return emptyInfo;

    // 还原被注释污染的真实 URL
    const decoded = tryDecode(raw);
    const cut = decoded.search(/[（(]/);
    const cleaned = cut === -1 ? decoded : decoded.slice(0, cut);
    let url: URL;
    try {
        url = new URL(cleaned);
    } catch {
        return emptyInfo;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return emptyInfo;

    const normalize = (s: string) => tryDecode(s).trim().replace(/[).,;，。；）]+$/, '').replace(/\/+$/, '');
    const text = normalize(linkText);
    const target = normalize(cleaned);
    const isSource = /^https?:\/\//.test(text) && (text === target || target.startsWith(text) || text.startsWith(target));
    if (!isSource) return emptyInfo;

    const host = KNOWN_SITES[url.hostname] ?? url.hostname.replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    let pathLabel: string;
    if (segments.length === 0) {
        pathLabel = url.hostname;
    } else if (segments.length <= 2) {
        pathLabel = segments.join(' / ');
    } else {
        pathLabel = `…/${segments.slice(-2).join(' / ')}`;
    }
    const decodedText = tryDecode(linkText.trim());
    const note = decodedText.startsWith(cleaned) ? decodedText.slice(cleaned.length) : '';
    return { isSource: true, url: cleaned, host, pathLabel, note };
}
