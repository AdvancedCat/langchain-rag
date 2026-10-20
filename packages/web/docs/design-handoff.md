# 对话类应用设计规范 Handoff

> **这是一份自包含（self-contained）的设计交接文件**：不依赖任何外部仓库，单文件即可在新项目中复刻整套设计体系。
>
> **来源**：`langchain-rag` 仓库 `packages/web`（Docs RAG Chat，2026-10-20 状态快照）。源规范为同目录 `design-system.md` + `src/index.css`。
>
> **适用**：AI 问答 / 对话类 Web 应用（React + Vite + Tailwind CSS v4）。

## 0. 使用方式与品牌适配点

**使用方式（三选一）**：

1. 复制本文件到新项目 `docs/design-handoff.md`，并在该项目的 `AGENTS.md` / `CLAUDE.md` 中加一行：「UI 一切决策遵循 `docs/design-handoff.md`」。
2. 开发时把本文件整体投喂给 AI 编码 agent，指令：「严格按此规范搭建界面，禁止偏离 token 体系」。
3. 人类工程师直接按 §9 落地步骤执行。

**品牌适配点（每个新项目先定这几项，其余一律照抄）**：

| 适配点 | 说明 |
|---|---|
| accent 色对 | 浅色主题主色（如品牌蓝 500 `rgb(65 118 230)`）+ 深色主题主色（品牌蓝 400 `rgb(122 170 255)`）。深色主色须比浅色**亮一档** |
| `--accent-hover` | 浅色 hover 比主色**亮**，深色 hover 比主色**深**（方向相反） |
| `--accent-fg` | 浅色通常白；深色必须实测对比度——白字若不达 3:1 就翻近黑（如 `rgb(15 17 21)`） |
| `--bubble` | 用户气泡底。浅色 = accent-soft 同族淡色；深色 = 中性灰（**不要**用深色 accent，会太饱和） |
| 品牌 mark | 自绘 SVG，currentColor 着色，置于 `bg-accent` 圆角块内 |
| 文案 | 应用名、输入框 placeholder、空态标题/副标题、错误文案映射 |

适配后必须重跑 §9 验收清单（对比度按新色值重算）。

---

## 1. 设计原则（不可妥协）

风格定位：**极简瑞士风（Minimalism & Swiss）· 开发者工具 · 双主题（浅色默认 + 深色）**。

1. **内容优先**：答案正文是唯一主角。过程、装饰一律退后——折叠、弱化、hairline。AI 回答不加头像、不加底色、不加逐条时间戳。
2. **单强调色纪律**：accent 是全站唯一强调色，只用于交互意图与激活态；状态语义色（绿/黄/红）仅表状态，不做装饰。
3. **克制即质感**：1px hairline 边框代替阴影；微动效代替大动画；留白代替分隔线堆叠。
4. **对比度红线**：有信息量的文本最低用 `text-content-secondary`（浅 ~5.8:1 / 深 ~12.1:1）；`text-content-muted`（浅 ~2.1:1）**仅限装饰性文本**（分隔符、placeholder、禁用态）。豁免：输入框 placeholder（聚焦即消失）可用 muted 与正文拉开层级。

---

## 2. 技术基座与依赖

- React 19 + Vite + TypeScript（ESM）；状态自研（纯函数归约 store + `useSyncExternalStore`），**不引组件库、路由库、状态库**（默认纪律，按需才破例）。
- 样式：**Tailwind CSS v4 CSS-first**——无 `tailwind.config` 文件，用 `@tailwindcss/vite` 插件，token 全部写进 `src/index.css` 的 `@theme`。
- Markdown：`react-markdown` + `remark-gfm` + `rehype-highlight`，高亮主题 `highlight.js/styles/github-dark.css`。**不引 typography 插件**，排版手写在 `.md-body`（见 §4）。
- 图标：`lucide-react`，16px 网格线性、`strokeWidth` 统一 1.5、`currentColor`、默认 `aria-hidden`。语义一图一义（如思考 Brain / 工具 Wrench / 子代理 Bot / 聚合 Workflow），禁止 emoji 作结构性图标。
- 字体自托管（不依赖 Google Fonts 运行时）：`@fontsource-variable/inter`（界面）+ `@fontsource/jetbrains-mono` 400/500（代码），中文回退 PingFang SC / Hiragino Sans GB / Microsoft YaHei。

```json
{
  "dependencies": {
    "@fontsource-variable/inter": "^5.3.0",
    "@fontsource/jetbrains-mono": "^5.3.0",
    "highlight.js": "^11",
    "lucide-react": "^1.59.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-markdown": "^10.1.0",
    "rehype-highlight": "^7.0.2",
    "remark-gfm": "^4.0.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.14",
    "tailwindcss": "^4.1.14"
  }
}
```

`main.tsx` 引入顺序：字体 CSS 在 `index.css` 之前。

```ts
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
```

---

## 3. Design Tokens（完整 CSS，直接复制为新项目 `src/index.css`）

三层纪律：

```
primitive 层   Tailwind 默认调色板 + 色阶字面值（rgb() 直写），只允许出现在本文件
semantic 层    :root / .dark 下的 CSS 变量（--canvas、--content-secondary ...）
component 层   JSX 中只使用语义工具类（bg-canvas、text-content-secondary、border-line ...）
```

- 组件代码**禁止**出现 `zinc-*`、`indigo-*` 等色阶类或色值字面量。
- 颜色 token 走 `@theme inline`（工具类引用变量，`.dark` 切换即时生效，组件几乎不需要 `dark:` 前缀）；字体/圆角/时长走 `@theme static`（不随主题切换，强制发射）。

```css
@import "tailwindcss";

/* 深色模式按 html.dark 类切换（默认跟随系统，手动选择存 localStorage，见 §5） */
@custom-variant dark (&:where(.dark, .dark *));

:root {
    color-scheme: light;
    --canvas: #ffffff;                    /* 页面底 */
    --surface: rgb(249 250 251);          /* 侧栏/卡片/聚合块底（neutral-bluish-50） */
    --inset: rgb(241 243 245);            /* 内嵌代码/参数/结果区底（neutral-bluish-75） */
    --line: rgb(233 236 242);             /* 常规 hairline（neutral-bluish-150） */
    --line-strong: rgb(225 229 238);      /* 强分隔/悬停边框（neutral-bluish-200） */
    --content: rgb(15 17 21);             /* 正文（neutral-bluish-1000） */
    --content-secondary: rgb(97 102 107);  /* 次级/有信息量的弱文本（neutral-bluish-700） */
    --content-muted: rgb(173 178 184);    /* 仅装饰性文本（neutral-bluish-400） */
    --accent: rgb(65 118 230);            /* 品牌蓝 500（★品牌适配点） */
    --accent-hover: rgb(122 170 255);     /* 品牌蓝 400（浅色 hover 变亮） */
    --accent-fg: #ffffff;
    --accent-soft: rgb(237 243 254);      /* 品牌蓝 50（激活态底） */
    --bubble: var(--accent-soft);         /* 用户气泡软底 = 淡蓝 */
    --composer-card: #ffffff;             /* 悬浮输入卡底（浅色 = 白，靠投影成形） */
    --elevation-card: 0 0 0 0.5px var(--line), 0 4px 16px rgb(0 0 0 / 3%),
        0 0 24px rgb(0 0 0 / 3%);         /* 悬浮卡投影（0.5px 描边 + 双层淡投影，两主题同值） */
    --success: rgb(34 197 94);            /* green-500 */
    --success-fg: rgb(21 128 61);         /* green-700（on soft 文本） */
    --success-soft: rgb(230 250 237);     /* 淡绿底 */
    --warning: rgb(245 158 11);           /* amber-500 */
    --warning-fg: var(--color-amber-700);
    --warning-soft: rgb(254 245 231);     /* 淡琥珀底 */
    --danger: rgb(236 19 19);             /* red-600 */
    --danger-fg: var(--color-red-700);
    --danger-soft: rgb(254 242 242);      /* red-50 */
    --ring: var(--accent);
    /* 过程块类型色：思考 violet / 工具 line-strong / 子代理 accent */
    --process-reasoning: var(--color-violet-400);
    --process-tool: var(--line-strong);
    --process-subagent: var(--accent);
    /* 代码块「深岛」内容色（恒定深底，两主题共用） */
    --code-bright: rgb(235 238 242);      /* neutral-bluish-100 */
    --code-muted: rgb(173 178 184);       /* neutral-bluish-400 */
    --code-chip: rgb(53 54 56);           /* neutral-bluish-800 */
    --code-chip-hover: rgb(67 69 74);     /* neutral-bluish-750 */
    /* 抽屉遮罩（两主题同值） */
    --scrim: color-mix(in oklab, rgb(15 17 21) 40%, transparent);
    /* 次级操作按钮：浅色 rest 淡灰 → hover 深灰反色、文本翻白 */
    --btn-secondary-bg: #f9fafb;
    --btn-secondary-bg-hover: #353638;
    --btn-secondary-fg-hover: #ffffff;
}
.dark {
    color-scheme: dark;
    --canvas: rgb(21 21 23);              /* neutral-bluish-950 */
    --surface: rgb(27 27 28);             /* neutral-bluish-900 */
    --inset: rgb(21 21 23);
    --line: rgb(53 54 56);                /* neutral-bluish-800 */
    --line-strong: rgb(67 69 74);         /* neutral-bluish-750 */
    --content: rgb(249 250 251);          /* neutral-bluish-50 */
    --content-secondary: rgb(207 211 214); /* neutral-bluish-300 */
    --content-muted: rgb(129 133 140);    /* 仅装饰性文本（neutral-bluish-600） */
    --accent: rgb(122 170 255);           /* 品牌蓝 400（★品牌适配点） */
    --accent-hover: rgb(65 118 230);      /* 品牌蓝 500（深色 hover 变深） */
    --accent-fg: rgb(15 17 21);           /* 深色主按钮前景近黑（白字在品牌蓝 400 上仅 2.3:1） */
    --accent-soft: color-mix(in oklab, rgb(122 170 255) 12%, transparent);
    --bubble: rgb(44 44 46);              /* neutral-bluish-850（深色气泡为中性灰底） */
    --composer-card: rgb(44 44 46);       /* 深色 = neutral-bluish-850 */
    --success: rgb(34 197 94);            /* green-500 */
    --success-fg: rgb(78 209 126);        /* 亮绿 */
    --success-soft: color-mix(in oklab, rgb(34 197 94) 12%, transparent);
    --warning: rgb(245 158 11);           /* amber-500 */
    --warning-fg: var(--color-amber-400);
    --warning-soft: color-mix(in oklab, rgb(245 158 11) 12%, transparent);
    --danger: rgb(242 90 90);             /* 亮红 */
    --danger-fg: rgb(254 226 226);        /* 淡红 */
    --danger-soft: color-mix(in oklab, rgb(242 90 90) 12%, transparent);
    --ring: var(--accent);
    /* 次级操作按钮：深色 rest 同画布（仅边框成形），hover 提亮、文本保持近白 */
    --btn-secondary-bg: var(--canvas);
    --btn-secondary-bg-hover: #353638;
    --btn-secondary-fg-hover: var(--content);
}

/* 颜色走 inline：工具类直接引用语义变量，.dark 切换即时生效 */
@theme inline {
    --color-canvas: var(--canvas);
    --color-surface: var(--surface);
    --color-inset: var(--inset);
    --color-line: var(--line);
    --color-line-strong: var(--line-strong);
    --color-content: var(--content);
    --color-content-secondary: var(--content-secondary);
    --color-content-muted: var(--content-muted);
    --color-accent: var(--accent);
    --color-accent-hover: var(--accent-hover);
    --color-accent-fg: var(--accent-fg);
    --color-accent-soft: var(--accent-soft);
    --color-bubble: var(--bubble);
    --color-composer-card: var(--composer-card);
    --shadow-card: var(--elevation-card);
    --color-success: var(--success);
    --color-success-fg: var(--success-fg);
    --color-success-soft: var(--success-soft);
    --color-warning: var(--warning);
    --color-warning-fg: var(--warning-fg);
    --color-warning-soft: var(--warning-soft);
    --color-danger: var(--danger);
    --color-danger-fg: var(--danger-fg);
    --color-danger-soft: var(--danger-soft);
    --color-ring: var(--ring);
    --color-process-reasoning: var(--process-reasoning);
    --color-process-tool: var(--process-tool);
    --color-process-subagent: var(--process-subagent);
    --color-code-bright: var(--code-bright);
    --color-code-muted: var(--code-muted);
    --color-code-chip: var(--code-chip);
    --color-code-chip-hover: var(--code-chip-hover);
    --color-scrim: var(--scrim);
    --color-btn-secondary-bg: var(--btn-secondary-bg);
    --color-btn-secondary-bg-hover: var(--btn-secondary-bg-hover);
    --color-btn-secondary-fg-hover: var(--btn-secondary-fg-hover);
}

/* 字体与动效时长不随主题切换；static 强制发射 */
@theme static {
    --radius-panel: 28px; /* 悬浮输入卡面板圆角（全站第五档） */
    --font-sans: "Inter Variable", ui-sans-serif, system-ui, -apple-system,
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --duration-fast: 150ms;
    --duration-base: 200ms;
    --duration-enter: 250ms;
}

html,
body,
#root {
    height: 100%;
}

/* 字体灰度抗锯齿：macOS 默认次像素渲染会让深底白字显得过粗过亮；两主题统一生效 */
html {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* 键盘焦点全局可见；必须在 @layer base——非分层样式会压过 utilities，
   组件将无法用 focus-visible:outline-none 接管（如 Composer 把焦点指示上移到卡级 ring） */
@layer base {
    :focus-visible {
        outline: 2px solid var(--ring);
        outline-offset: 2px;
    }
}
```

**工具类速查**：`bg-canvas / bg-surface / bg-inset / bg-bubble / bg-accent(-soft / -hover)`、`text-content(-secondary / -muted) / text-accent(-fg)`、`border-line(-strong)`、`shadow-card`、`rounded-panel`、`duration-fast/base`、状态三件 `success/warning/danger` 均带 `-fg/-soft`、过程色 `process-reasoning/tool/subagent`、深岛 `code-bright/muted/chip`、`bg-scrim`。

---

## 4. 全局 CSS 类库（追加到 `src/index.css`，与 §3 同文件）

### 4.1 过程时间线（`.tl-step` / `.tl-dot`）

8px 类型色节点 + 2px line 连接线；步骤内容带左 3px 类型色条。

```css
.tl-step {
    position: relative;
    display: flex;
    gap: 0.625rem;
}
.tl-step::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 0.625rem;
    bottom: -0.5rem;
    width: 2px;
    background: var(--line);
}
.tl-step:last-child::before {
    content: none;
}
.tl-dot {
    position: relative;
    z-index: 1;
    margin-top: 0.375rem;
    height: 8px;
    width: 8px;
    flex-shrink: 0;
    border-radius: 9999px;
}
```

### 4.2 入场动画（`.enter-in`）

新消息/新块入场：opacity 0→1 + translateY(4px→0)；reduced-motion 关停。

```css
@media (prefers-reduced-motion: no-preference) {
    .enter-in {
        animation: enter-in var(--duration-enter) ease-out both;
    }
}
@keyframes enter-in {
    from {
        opacity: 0;
        transform: translateY(4px);
    }
}
```

### 4.3 细滚动条（`.thin-scrollbar`）

```css
.thin-scrollbar {
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
}
.thin-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}
.thin-scrollbar::-webkit-scrollbar-thumb {
    background: var(--line-strong);
    border-radius: 3px;
}
.thin-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}
```

### 4.4 Markdown 排版（`.md-body`，手写最小集，不引 typography 插件）

正文 15px/1.75；h1/h2/h3 = 20/18/16px；行内代码 mono 13px inset 底；**代码块恒定深底**（「深岛」——浅色主题下也是深底，与 github-dark 高亮主题统一，深色主题加 hairline）。

```css
.md-body {
    font-size: 0.9375rem;
    line-height: 1.75;
    color: var(--content);
    overflow-wrap: break-word;
}
.md-body > :first-child { margin-top: 0; }
.md-body > :last-child { margin-bottom: 0; }
.md-body p { margin: 0.5rem 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 {
    font-weight: 600;
    color: var(--content);
    margin: 1.2em 0 0.5em;
    line-height: 1.4;
}
.md-body h1 { font-size: 1.25rem; }
.md-body h2 { font-size: 1.125rem; }
.md-body h3 { font-size: 1rem; }
.md-body ul, .md-body ol {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
}
.md-body ul { list-style: disc; }
.md-body ol { list-style: decimal; }
.md-body li { margin: 0.25rem 0; }
.md-body a {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--accent) 35%, transparent);
    text-underline-offset: 2px;
}
.md-body a:hover { text-decoration-color: var(--accent); }

/* 来源引用徽标：链接文本为 URL 本身时替代原始长链接 */
.md-body a.source-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4em;
    max-width: 100%;
    background: var(--inset);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.1em 0.55em;
    font-size: 0.85em;
    line-height: 1.5;
    color: var(--content-secondary);
    text-decoration: none;
    vertical-align: baseline;
    white-space: nowrap;
}
.md-body a.source-chip:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    text-decoration: none;
}
.md-body a.source-chip .source-host {
    font-weight: 600;
    color: var(--content);
}
.md-body a.source-chip .source-path {
    color: var(--content-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
}

.md-body code {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: var(--inset);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.1em 0.35em;
}
/* 代码块深岛：恒定深底 rgb(27 27 28)，与高亮主题统一；深色主题下加 hairline */
.md-body pre {
    background: rgb(27 27 28);
    color: var(--code-bright);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    overflow-x: auto;
    margin: 0.75rem 0;
    font-size: 0.8125rem;
    line-height: 1.6;
}
.dark .md-body pre { border: 1px solid var(--line); }
.md-body pre code {
    background: transparent;
    border: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
    font-family: inherit;
}
.md-body blockquote {
    border-left: 3px solid var(--line-strong);
    padding-left: 0.75rem;
    margin: 0.75rem 0;
    color: var(--content-secondary);
}
.md-body table {
    border-collapse: collapse;
    margin: 0.75rem 0;
    font-size: 0.875rem;
    display: block;
    overflow-x: auto;
}
.md-body th, .md-body td {
    border: 1px solid var(--line);
    padding: 0.35rem 0.75rem;
    text-align: left;
}
.md-body th {
    background: var(--surface);
    font-weight: 600;
}
.md-body hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 1rem 0;
}
```

### 4.5 流式光标（`.stream-cursor`）

挂在正在流式输出的 `.md-body` 上；reduced-motion 降级为静态。

```css
.stream-cursor::after {
    content: "▍";
    margin-left: 1px;
    color: var(--accent);
}
@media (prefers-reduced-motion: no-preference) {
    .stream-cursor::after {
        animation: cursor-blink 1s steps(1) infinite;
    }
}
@keyframes cursor-blink {
    50% { opacity: 0; }
}
```

---

## 5. 暗色模式三件套

机制：`html.dark` 类切换。默认跟随 `prefers-color-scheme`，手动选择存 localStorage（`theme` 键）后不再跟随系统。

**① index.html 首帧前落类（防闪白）**：

```html
<script>
  (function () {
    var stored = localStorage.getItem('theme');
    var dark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  })();
</script>
```

**② useTheme hook**：

```ts
export type ThemeChoice = 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme';

function resolveTheme(): ThemeChoice {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 默认跟随 prefers-color-scheme；手动选择后系统变化不再跟随 */
export function useTheme(): [ThemeChoice, (theme: ThemeChoice) => void] {
    const [theme, setTheme] = useState<ThemeChoice>(resolveTheme);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (localStorage.getItem(THEME_STORAGE_KEY) !== null) return;
            const next = resolveTheme();
            document.documentElement.classList.toggle('dark', next === 'dark');
            setTheme(next);
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, []);
    const apply = (next: ThemeChoice) => {
        localStorage.setItem(THEME_STORAGE_KEY, next);
        document.documentElement.classList.toggle('dark', next === 'dark');
        setTheme(next);
    };
    return [theme, apply];
}
```

**③ token 成对覆写**（已在 §3：所有颜色 token 在 `:root` / `.dark` 两组成对定义，经 `@theme inline` 引用）。

纪律：**深色不是浅色简单反色**——每档独立调值（accent 换亮一档、bubble 改中性灰、soft 改 12% tint、accent-fg 可能翻黑）。组件代码几乎不出现 `dark:` 前缀；两主题分别人工验证对比度。主题切换按钮放侧栏底部。

---

## 6. 布局骨架

整体：`flex h-full` 横排 = 左侧栏 + 右主区（顶栏 / 消息滚动区 / Composer 纵排）。**唯一断点 `md`（768px）**：<768px 侧栏收为抽屉。

```
┌────────┬──────────────────────────┐
│        │ 顶栏（bg-canvas 下 hairline）│
│ 侧栏    ├──────────────────────────┤
│ 264px  │ 消息列 mx-auto max-w-3xl   │
│ surface│ (space-y-8, 滚动)          │
│ 右hairline├──────────────────────────┤
│        │ Composer 悬浮卡             │
└────────┴──────────────────────────┘
```

关键量化：

- 侧栏固定 **264px**，`bg-surface` + 右 hairline；激活项 `bg-accent-soft text-accent`；hover 才显现的删除按钮（`group-hover`）。
- 消息列 `max-w-3xl`（768px）居中、`space-y-8`；页边距移动 16px（`px-4`）、≥768px 24px（`md:px-6`）。
- **滚动区必须带 `[scrollbar-gutter:stable_both-edges]`**：经典滚动条占位会把内容列居中基准挤偏（实测双肩不对称），对称预留 gutter 后恢复。
- 间距 4px 基数：组件内 8/12，卡片内 12/16，区块间 16/24/32。
- 圆角全站仅五档：6px（内嵌 pre/徽标/chip）、8px（卡片）、12px（次级按钮）、16px（用户气泡，右下 6px 破折）、28px（面板 `rounded-panel`，悬浮输入卡专用）。
- 边框全局 1px hairline；3px 仅过程块左色条与 blockquote；禁止 2px。阴影：卡片层级靠 `border-line` 表达，`shadow-sm` 仅限悬浮元素，禁止 md 及以上。

**移动端抽屉**（scrim 点击 / Esc / 选中项 关闭；打开时焦点移入面板）：

```tsx
<div className={`fixed inset-0 z-40 md:hidden ${sidebarOpen ? '' : 'pointer-events-none'}`} aria-hidden={!sidebarOpen}>
    <div
        aria-hidden="true"
        onClick={closeSidebar}
        className={`absolute inset-0 bg-scrim transition-opacity motion-safe:duration-base ${
            sidebarOpen ? 'opacity-100 motion-safe:ease-out' : 'opacity-0 motion-safe:ease-in'
        }`}
    />
    <aside
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="会话导航"
        className={`absolute inset-y-0 left-0 flex w-[264px] flex-col bg-surface shadow-sm outline-none transition-[transform,visibility] motion-safe:duration-base ${
            sidebarOpen ? 'visible translate-x-0 motion-safe:ease-out' : 'invisible -translate-x-full motion-safe:ease-in'
        }`}
    >
        {/* <Sidebar ... /> */}
    </aside>
</div>
```

---

## 7. 对话界面模式库

### 7.1 Turn 单轮模型（数据结构先行）

一次问答 = 一个 Turn，渲染分三段：**用户气泡 → 过程聚合块（默认折叠）→ 最终答案正文 + 状态 + 元信息行**。用纯函数把块的有序列表 partition 成「过程块」与「答案块」（首个正文 text 块及之后为答案，之前的 reasoning/toolcall/subagent 为过程）。

```ts
interface Turn {
    userText: string | null;   // null = 断线恢复后历史缺失，流式期间显示占位气泡
    blocks: ChatBlock[];       // 按 arrive 顺序：reasoning / text / toolcall / subagent
    status: 'streaming' | 'done' | 'error' | 'cancelled';
    error?: { code?: string; message: string };
    usage?: { totalTokens: number };
    createdAt: number;         // 完成轮元信息行显示时间
    traceId?: string;          // 可观测性芯片（可选）
}
```

### 7.2 用户消息 = 软底气泡

右对齐、`bg-bubble`（浅色淡 accent / 深色中性灰）、16px 圆角 + 右下 6px 破折、`max-w-[85%]`、15px/1.625、`whitespace-pre-wrap`。历史缺失时显示同底占位气泡。

```tsx
<div className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-content">
        {turn.userText}
    </div>
</div>
```

### 7.3 AI 回答 = 无容器

不加头像、不加底色、无逐条时间戳，直接 `.md-body` 排版（内容优先）。正文块缩进对齐时间线步骤内容（`pl-[18px]`），流式时挂 `stream-cursor`：

```tsx
<li className="min-w-0 pl-[18px]">
    <Markdown content={block.content} streaming={!block.done} />
</li>
```

```tsx
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
    return (
        <div className={`md-body ${streaming ? 'stream-cursor' : ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} /* components 见 7.5/7.9 */ >
                {content}
            </ReactMarkdown>
        </div>
    );
}
```

### 7.4 流式状态分层

| 阶段 | 表现 |
|---|---|
| 无块 + streaming | `IconSpinner`（accent `animate-spin`）+「思考中…」 |
| 有过程块、答案未开始 | 「生成中…」 |
| 顶栏 | 「回答生成中」pill：`bg-success-soft` + success 呼吸点（`motion-safe:animate-pulse`）+ 文字 |
| 流式光标 | `.stream-cursor` 挂在正在输出的 md-body 上 |
| 用户停止 | 「已停止」次级文本 |
| 错误 | §7.8 错误条 |

常驻动画**全部**包 `motion-safe:` 或 `@media (prefers-reduced-motion: no-preference)`。

### 7.5 代码块：深岛 + 工具条

深底恒定（浅色主题也是深底，与 github-dark 高亮统一）；右上角语言标签 + 复制按钮 hover/focus 显现；复制走 §7.7 通用反馈。

```tsx
function CodeBlock({ lang, raw, children }: { lang: string | null; raw: string; children: ReactNode }) {
    const { copied, copy } = useCopy();
    return (
        <div className="group/code relative">
            {/* pre 覆写后必须原样输出 children：深岛背景/横向滚动样式都挂在 .md-body pre 上 */}
            <pre>{children}</pre>
            <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover/code:opacity-100">
                {lang && (
                    <span className="rounded bg-code-chip px-1.5 py-1 font-mono text-[11px] leading-none text-code-muted">
                        {lang}
                    </span>
                )}
                <Tooltip label={copied ? '已复制' : '复制代码'}>
                    <button
                        type="button"
                        onClick={() => copy(raw)}
                        aria-label={copied ? '已复制' : '复制代码'}
                        className="flex h-6 w-6 items-center justify-center rounded bg-code-chip text-code-muted transition-colors hover:bg-code-chip-hover hover:text-code-bright"
                    >
                        {copied ? <IconCheck className="h-3.5 w-3.5 text-code-bright" /> : <IconCopy />}
                        {copied && <span className="sr-only">已复制</span>}
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}
```

react-markdown 的 `components.pre` 里从 hast 节点取 `language-*` 类名与纯文本（递归收集 text 节点——高亮后是嵌套 span）。

### 7.6 过程可视化：折叠 + 垂直时间线

一个 Turn 的思考/工具/子代理折叠进**单个聚合块**（头部：chevron + Workflow 图标 + 「思考与工具调用」+ 计数 `思考 ×N · 工具 ×N` + 状态图标），展开为垂直时间线；子代理内部递归嵌套同一 BlockList。

类型区分 = **左 3px 色条 + 专属图标 + 8px 节点色**：思考 violet（`--process-reasoning`）、工具 line-strong、子代理 accent。工具卡/思考块不再各自带边框。

```tsx
/** 折叠容器：grid-template-rows 0fr→1fr 过渡（禁止瞬时跳变）；进入 ease-out、退出 ease-in */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
    return (
        <div
            className={`grid motion-safe:transition-[grid-template-rows] motion-safe:duration-base ${
                open ? 'grid-rows-[1fr] motion-safe:ease-out' : 'grid-rows-[0fr] motion-safe:ease-in'
            }`}
        >
            <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
    );
}

/** 时间线步骤外壳：.tl-dot 类型色节点 + .tl-step 连接线 + 左 3px 类型色条 */
function TimelineStep({ dot, bar, children }: { dot: string; bar: string; children: ReactNode }) {
    return (
        <li className="tl-step enter-in">
            <span aria-hidden="true" className={`tl-dot ${dot}`} />
            <div className={`min-w-0 flex-1 border-l-[3px] pl-2.5 ${bar}`}>{children}</div>
        </li>
    );
}
```

工具步骤示例（头部按钮带 `aria-expanded`，展开看参数/结果——`bg-inset` 6px 圆角 pre + `max-h` + `thin-scrollbar` 滚动）：

```tsx
<TimelineStep dot="bg-process-tool" bar="border-l-process-tool">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 py-1 text-left text-sm text-content-secondary transition-colors hover:text-content">
        <IconChevron open={open} />
        <span className="text-content-muted"><IconWrench /></span>
        <span className="font-medium">{label}</span>
        <span className="ml-auto">{running ? <IconSpinner /> : <IconCheck />}</span>
    </button>
    <Collapsible open={open}>
        <div className="space-y-2 pb-1.5 pt-1">
            {block.args && (
                <div>
                    <div className="mb-1 text-xs font-medium text-content-secondary">参数</div>
                    <pre className="thin-scrollbar max-h-40 overflow-auto rounded-md bg-inset p-2 text-xs text-content-secondary">
                        {prettyJson(block.args)}
                    </pre>
                </div>
            )}
            {/* 结果同构：max-h-60 whitespace-pre-wrap，空结果显示（空） */}
        </div>
    </Collapsible>
</TimelineStep>
```

聚合块外壳：

```tsx
<div className="rounded-lg border border-line bg-surface">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-inset/60 hover:text-content">
        <IconChevron open={open} />
        <span className="text-content-muted"><IconWorkflow /></span>
        <span className="font-medium">思考与工具调用</span>
        <span className="text-xs text-content-secondary">{parts.join(' · ')}</span>
        <span className="ml-auto">{summary.allDone ? <IconCheck /> : <IconSpinner />}</span>
    </button>
    <Collapsible open={open}>
        <div className="border-t border-line/70 px-3 py-2.5">
            <BlockList blocks={blocks} />
        </div>
    </Collapsible>
</div>
```

### 7.7 复制反馈（通用交互模式）+ 元信息行

所有点击复制类控件统一：点击后切「已复制」（SVG check，accent 色），≤1.6s 自动回退，**控件尺寸不变（无布局位移）**。

```ts
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timerRef.current), []);
    const copy = useCallback((text: string) => {
        void navigator.clipboard
            ?.writeText(text)
            .then(() => {
                setCopied(true);
                clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => undefined);
    }, []);
    return { copied, copy };
}
```

完成轮正文底部元信息行（12px `content-secondary`、`tabular-nums`、纯文本不带图标、`flex-wrap` 窄屏换行）：

```
[复制回答 icon-btn] · 用量 12.3K tok · 10月20日 14:30 · [trace abc12345… chip]
```

- 复制回答：`h-8 w-8` 触达，hover 高亮统一 `bg-content/10`（禁 `bg-inset`——深色下与画布同色不可见）+ Tooltip。
- 用量 ≥1 万取整 K，≥1 千一位小数。
- 时间恒为 `M月D日 HH:mm`。
- 流式/异常/取消轮：trace 芯片单独成行（运行中即可复制）。

### 7.8 错误条

`danger` 语义：12% tint 底 + danger 30% 边框 + danger 文本；错误码 → 人话文案映射；重试为描边式按钮。

```tsx
<div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-fg">
    <span>{errorText(turn.error)}</span>
    {canRetry && (
        <button type="button" onClick={() => onRetry(text)}
            className="shrink-0 rounded-md border border-danger/40 px-2 py-0.5 text-xs font-medium text-danger-fg hover:bg-danger/10">
            重试
        </button>
    )}
</div>
```

### 7.9 来源引用徽标（source-chip）

RAG 场景：答案中「链接文本为 URL 本身」的链接（含 GFM autolink 括号污染修复）渲染为紧凑 chip 替代原始长 URL——`Link2` 图标 + host（`font-semibold`）+ 路径摘要（ellipsis），样式见 §4.4 `a.source-chip`。

### 7.10 Composer：悬浮输入卡（面板式）

**卡宽 = 正文列 + 2×圆角半径**（`max-w-[calc(48rem+56px)]`，正文边缘与圆弧终点精确相接；肩宽若小于半径会留楔形缺口——实测结论）。无边框投影即描边；单行布局文本区为主角，44px 圆钮贴右下。

```tsx
<div className="px-4 pb-4 md:px-6">
    <div className="mx-auto flex max-w-[calc(48rem+56px)] items-end gap-2 rounded-panel bg-composer-card py-2 pl-4 pr-2 shadow-card transition focus-within:ring-2 focus-within:ring-accent/20">
        <textarea
            rows={1}
            value={draft}
            placeholder="向知识库提问…"
            className="thin-scrollbar max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-[0.9375rem] leading-relaxed text-content placeholder:text-content-muted focus:outline-none focus-visible:outline-none"
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
                // Enter 发送 / Shift+Enter 换行 / 输入法合成中不发送
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                }
            }}
        />
        {running ? (
            <button type="button" onClick={onStop} aria-label="停止"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-content text-canvas transition hover:bg-content/85">
                <IconStop />
            </button>
        ) : (
            <button type="button" onClick={submit} disabled={!draft.trim()} aria-label="发送"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
                <IconArrowUp />
            </button>
        )}
    </div>
</div>
```

自动增高（上限 200px，border-box 高度补边框；未到上限隐藏纵向溢出避免常态滚动条）：

```ts
useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const borders = el.offsetHeight - el.clientHeight;
    const full = el.scrollHeight + borders;
    el.style.height = `${Math.min(full, 200)}px`;
    el.style.overflowY = full > 200 ? 'auto' : 'hidden';
}, [draft]);
```

要点：发送钮前景用 `text-accent-fg`（深色白箭头不达图形 3:1，不用强制白）；停止钮 `bg-content text-canvas` 反色；聚焦指示在**卡级** `focus-within:ring-2 ring-accent/20`，textarea 自身 `focus-visible:outline-none`；disabled `opacity-40`；不设底部提示文案（说明由空态副标题承担）；不做滚动区底部渐隐遮罩（会压住正在阅读的行）。

### 7.11 Tooltip（替代原生 title）

图标按钮的即时悬停提示：反色 chip（`bg-content text-canvas`）11px、6px 圆角，hover / 键盘聚焦即现（`duration-fast` 淡入），`pointer-events-none` 不拦截指针；placement 默认 `bottom`，贴近视口底部的控件用 `top`。SR 语义由控件自身 `aria-label` 承担。

### 7.12 字号体系

| 用途 | 字号/行高 |
|---|---|
| 正文（md-body）/ 输入框 / 用户气泡 | 15px / 1.75（气泡 1.625） |
| 控件次级文本 | 14px / 1.5 |
| 元信息、hint、计数 | 12px / 1.5 |
| 来源徽标 / 语言标签 | 11px |
| md 标题 h1/h2/h3 | 20 / 18 / 16 px，行高 1.4，semibold |
| 行内代码、代码块 | 13px / 1.6，mono |

数字场景（时间戳、计数、token 用量）加 `tabular-nums`；中文一律不加 `letter-spacing`。

---

## 8. 硬规则与反模式

**硬规则（违反即返工）**：

1. informative 文本（时间戳、计数、空态副标题、错误详情）最低 `text-content-secondary`，禁止 `text-content-muted`；裸状态点必须伴随文字标签。
2. 组件层禁止硬编码色阶类（`zinc-*` 等）与色值字面量——只允许出现在 `index.css` token 定义处。
3. 深色模式不得直接复用浅色对比值，两主题分别校验（≥4.5:1 正文；按钮文本 ≥3:1）。
4. 全局 `:focus-visible` 可见（定义在 `@layer base`）；组件接管时必须提供等价可见指示。
5. 触达目标 ≥32px（Composer 按钮保持 44px）；折叠控件带 `aria-expanded`；装饰图标 `aria-hidden`。
6. 常驻动画必须适配 `prefers-reduced-motion`（关停或降级静态）。

**反模式（禁止）**：

- ❌ emoji / 字符 dingbat（如 ✓）作结构性图标
- ❌ 第二强调色；渐变 / glassmorphism / 重阴影（md 及以上）
- ❌ 2px 边框（全局 1px hairline；3px 仅过程块色条与 blockquote）
- ❌ 瞬时跳变的展开/收起；布局位移式 hover 反馈
- ❌ 弹跳、视差、>300ms 装饰动画
- ❌ Google Fonts 运行时依赖（字体一律自托管）

---

## 9. 新项目落地步骤与验收

**步骤**：

1. Vite + React + TS 脚手架；装 §2 依赖；`vite.config.ts` 挂 `@tailwindcss/vite` 插件（**无 tailwind.config**）。
2. `src/index.css` ← §3 token 段 + §4 类库段（原样粘贴）。
3. `index.html` ← §5① 防闪白脚本；`main.tsx` ← §2 字体引入。
4. `hooks.ts` ← `useTheme`（§5②）+ `useCopy`（§7.7）。
5. 按 §6 搭布局骨架（侧栏 + 主区 + 移动抽屉）。
6. 按 §7 按需搬模式：Turn/气泡/markdown/代码块/时间线/元信息行/Composer/错误条/Tooltip。
7. 做 §0 品牌适配点替换（accent 色对、mark、文案）。
8. 过一遍 §8 清单。

**验收清单（每个 UI 变更必须过）**：

- [ ] 对比度实测：`content` on `canvas` ≥4.5:1 双主题；informative ≥ `content-secondary`；`accent-fg` on `accent` ≥3:1
- [ ] 双主题分别人工验证；375 / 768 / 1440px 三档验证
- [ ] 键盘走查：Tab 焦点可见、抽屉 Esc 关闭、折叠 aria-expanded
- [ ] `prefers-reduced-motion` 下无动画（光标/spinner/入场/折叠过渡）
- [ ] 组件代码中无色阶类与色值字面量（grep `zinc-\|indigo-\|rgb(` 兜底检查）
- [ ] 滚动区带 `[scrollbar-gutter:stable_both-edges]`，内容列双肩对称

---

## 10. 与源项目的同步

本文件是 `langchain-rag` 仓库 `packages/web` 的设计体系快照导出。真源是该仓库的 `docs/design-system.md`（含对比度验算过程与落地路线历史）+ `src/index.css`。**源项目 token / 规范变更时应同步回填本文件**；本文件分发到新项目后独立演化，不反向同步。
