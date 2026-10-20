# Docs RAG Chat — 设计系统规范（MASTER）

> **检索规则：** 为某个页面/组件做 UI 时，先查 `design-system/docs-rag-chat/pages/[page-name].md`；
> 存在则其规则**覆盖**本文件，不存在则严格遵循本文件。
>
> **Project:** Docs RAG Chat（`packages/web`，React 19 + Tailwind CSS v4）
> **Generated:** 2026-10-11（ui-ux-pro-max 检索 + 现状审查，方向经确认）
> **Updated:** 2026-10-19（纳入 PR #2 TraceChip 规范修订；P1 实施：§2 增补 `--accent-hover` 与状态色 `-fg`/`-soft` 衍生 token，duration 经 `@theme static` 发射；P2 实施：§2 增补过程块类型色与深岛前景 token，§6 完成 lucide 迁移与图标语义拆分；P3 实施：品牌 mark（文档+检索字形）替换 R 字母块、§7 抽屉侧栏落地（§2 增补 `--scrim`）、空态视觉增强与 §5 页边距/§9 触达达标；P3 追加：§7 新增答案元信息行（复制回答 / 用量 / 时间，用量经 api CUSTOM `run.usage` 事件透出））
> **Style:** Minimalism & Swiss（极简瑞士风）· 开发者工具 · 双主题（浅色默认 + 深色）

---

## 1. 风格定位与设计原则

单色中性基底 + 单一强调色，hairline 边框代替阴影，内容优先、装饰最小。
检索依据：Minimalism & Swiss Style 官方标注 best for 文档站 / SaaS / 专业工具，性能成本最低；
开发者工具类产品的深色模式倾向（编码平台首选）以**第二主题**形式满足，不作为默认。

1. **内容优先**：答案正文是唯一主角，过程与装饰一律退后（折叠、弱化、hairline）。
2. **单强调色纪律**：indigo 是全站唯一强调色，只用于交互意图与激活态；状态语义色（绿/黄/红）仅表状态。
3. **克制即质感**：1px 边框代替阴影，微动效代替大动画，留白代替分隔线堆叠。

---

## 2. Token 架构（三层）

**唯一定义处：`packages/web/src/index.css`。**

```
primitive 层   Tailwind 默认调色板（zinc-*/indigo-*/emerald-*/...），只允许出现在本文件 token 定义处
semantic 层    :root / .dark 下的 CSS 变量（--canvas、--content-secondary ...）
component 层   JSX 中只使用语义工具类（bg-canvas、text-content-secondary、border-line ...）
```

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

:root {
    --canvas: #ffffff;                    /* 页面底 */
    --surface: var(--color-zinc-50);      /* 侧栏/卡片/聚合块底 */
    --inset: var(--color-zinc-100);       /* 内嵌代码/参数/结果区底 */
    --line: var(--color-zinc-200);        /* 常规 hairline */
    --line-strong: var(--color-zinc-300); /* 强分隔/悬停边框 */
    --content: var(--color-zinc-800);     /* 正文 */
    --content-secondary: var(--color-zinc-600);  /* 次级/有信息量的弱文本 */
    --content-muted: var(--color-zinc-400);      /* 仅装饰性文本 */
    --accent: var(--color-indigo-600);
    --accent-hover: var(--color-indigo-500);     /* accent 悬停态（P1 增补） */
    --accent-fg: #ffffff;
    --accent-soft: var(--color-indigo-50);
    --success: var(--color-emerald-600);
    --success-fg: var(--color-emerald-700);      /* §3.2 状态文本（P1 增补） */
    --success-soft: var(--color-emerald-50);     /* §3.2 状态底色（P1 增补） */
    --warning: var(--color-amber-500);
    --warning-fg: var(--color-amber-700);
    --warning-soft: var(--color-amber-50);
    --danger: var(--color-red-600);
    --danger-fg: var(--color-red-700);
    --danger-soft: var(--color-red-50);
    --ring: var(--color-indigo-600);
    /* 过程块类型色（§7，P2 增补）：思考 violet / 工具 line-strong / 子代理 accent；
       -tool/-subagent 引用已主题化变量，html 上 :root/.dark 同元素级联即随主题切换 */
    --process-reasoning: var(--color-violet-400);
    --process-tool: var(--line-strong);
    --process-subagent: var(--accent);
    /* 代码块「深岛」前景/胶囊底（恒定 zinc-900 底，两主题共用，P2 增补） */
    --code-bright: var(--color-zinc-100);
    --code-muted: var(--color-zinc-400);
    --code-chip: var(--color-zinc-800);
    --code-chip-hover: var(--color-zinc-700);
    /* 抽屉遮罩（P3 增补，两主题同值） */
    --scrim: color-mix(in oklab, var(--color-zinc-950) 40%, transparent);
}
.dark {
    --canvas: var(--color-zinc-950);
    --surface: var(--color-zinc-900);
    --inset: var(--color-zinc-950);
    --line: var(--color-zinc-800);
    --line-strong: var(--color-zinc-700);
    --content: var(--color-zinc-100);
    --content-secondary: var(--color-zinc-400);
    --content-muted: var(--color-zinc-500);      /* 仅装饰性文本 */
    --accent: var(--color-indigo-500);
    --accent-hover: var(--color-indigo-400);
    --accent-fg: #ffffff;
    --accent-soft: color-mix(in oklab, var(--color-indigo-500) 12%, transparent);
    --success: var(--color-emerald-500);
    --success-fg: var(--color-emerald-400);
    --success-soft: color-mix(in oklab, var(--color-emerald-500) 12%, transparent);
    --warning: var(--color-amber-500);
    --warning-fg: var(--color-amber-400);
    --warning-soft: color-mix(in oklab, var(--color-amber-500) 12%, transparent);
    --danger: var(--color-red-500);
    --danger-fg: var(--color-red-400);
    --danger-soft: color-mix(in oklab, var(--color-red-500) 12%, transparent);
    --ring: var(--color-indigo-500);
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
}

/* 字体与动效时长不随主题切换；static 强制发射（Tailwind v4 默认 tree-shake 未引用变量） */
@theme static {
    --font-sans: "Inter Variable", ui-sans-serif, system-ui, -apple-system,
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --duration-fast: 150ms;
    --duration-base: 200ms;
    --duration-enter: 250ms;
}
```

深色模式机制：`html.dark` 类切换（`@custom-variant dark`）；默认跟随 `prefers-color-scheme`，手动选择存 localStorage（`theme` 键），index.html 内联脚本在首帧前落类防闪白，切换按钮在侧栏底部。

品牌 mark（P3）：「文档 + 检索」几何字形（`components/BrandMark.tsx`，currentColor 着色），置于 bg-accent 圆角块内——侧栏头部 h-7 块/h-4 字形、空态 h-14 块/h-8 字形，替换原「R」字母块。

---

## 3. 色彩规范

### 3.1 对比度校验表（已验算，近似值）

| 组合 | 浅色 | 深色 | 判定 |
|---|---|---|---|
| `content` on `canvas` | ~14.8:1 | ~18:1 | ✓ 正文 |
| `content-secondary` on `canvas` | ~7.7:1 | ~7.7:1 | ✓ 次级正文/元信息 |
| `content-muted` on `canvas` | ~2.6:1 | ~4.1:1 | ✗ **仅装饰性**（分隔符、禁用态） |
| `accent-fg` on `accent` | ~6.3:1 | ~4.5:1 | ✓ 按钮文本 |
| `accent` on `accent-soft` | ~5.6:1 | — | ✓ 激活态文本 |

**硬规则：有信息量的文本（时间戳、计数、空态副标题、输入提示、底部说明、错误详情）最低 `text-content-secondary`，禁止 `text-content-muted`。** 现状中 `Sidebar.tsx` 时间戳、`ChatView.tsx` 空态副标题、`Composer.tsx` 底部提示、`blocks.tsx` 参数/结果小标题、`Turn.tsx` TraceChip（`text-zinc-500`，≈4.8:1 过 WCAG AA 但低于内部标准）均需按此上调。

### 3.2 状态色语义

| 语义 | 用法 | 文本/图标 | 底色 |
|---|---|---|---|
| success（绿） | 运行中、服务正常、完成 | 浅色 emerald-700 / 深色 emerald-400 | emerald-50 / 深色 12% tint |
| warning（黄） | 服务降级、重连中 | amber-700 / amber-400 | amber-50 / 深色 12% tint |
| danger（红） | 错误、删除悬停、不可达 | red-700 / red-400 | red-50 / 深色 12% tint |

状态点**必须**伴随文字标签，不允许裸色点传达状态。

---

## 4. 字体

- **界面**：Inter Variable（自托管 `@fontsource-variable/inter`）+ 系统中文栈回退；**代码**：JetBrains Mono（自托管 `@fontsource/jetbrains-mono` 400/500）。不引 Google Fonts 运行时依赖。
- 数字场景（时间戳、消息计数）加 `tabular-nums`；中文一律不加 `letter-spacing`；拉丁大标题可 `-0.01em`。

| 用途 | 字号/行高 |
|---|---|
| 正文（`md-body`） | 15px / 1.75 |
| 控件次级文本 | 14px / 1.5 |
| 元信息、hint、计数 | 12px / 1.5 |
| 来源徽标 | 11px |
| md 标题 h1 / h2 / h3 | 20 / 18 / 16 px，行高 1.4，semibold |
| 行内代码、代码块 | 13px / 1.6，mono |

---

## 5. 空间 · 圆角 · 边框 · 阴影

- **间距**：4px 基数。组件内 8/12，卡片内 12/16，区块间 16/24/32。消息流 `max-w-3xl`（768px）居中、`space-y-8`；页边距移动端 16px、≥768px 24px。
- **圆角**（全站仅四档）：6px 内嵌 pre / 徽标 / source-chip；8px 卡片；12px 输入框与主按钮；16px 用户气泡（右下角 6px 破折）。
- **边框**：全局 1px hairline；3px 仅用于过程块左色条与 blockquote；禁止 2px 边框。
- **阴影**：`shadow-sm` 仅限悬浮元素（新对话按钮、弹出层）；卡片层级靠 `border-line` 表达，禁止 md 及以上阴影。

---

## 6. 图标

- 16px 网格线性图标，**strokeWidth 统一 1.5**，`currentColor` 着色；尺寸：行内 14px（`h-3.5`）、按钮内 16px（`h-4`）。
- 来源策略：**已迁移 lucide-react**（tree-shakable，P2 落地；自绘图标仅存于规范附录）；语义拆分已落地：思考 Brain / 工具 Wrench / 子代理 Bot / 聚合 Workflow 各一义，**禁止同一图标表达两种语义**；正文旁装饰图标加 `aria-hidden="true"`。

---

## 7. 组件规范

| 组件 | 规范 |
|---|---|
| 侧栏 | `bg-surface`，宽 264px，右 hairline；激活项 `bg-accent-soft text-accent`；<768px 收起为抽屉 |
| 顶栏 | `bg-canvas`，下 hairline；「回答生成中」pill 用 success 语义（soft 底 + 呼吸点 + 文字） |
| 用户气泡 | `bg-accent text-accent-fg`，16px 圆角（右下 6px），max-w-[85%]，15px/1.625 |
| AI 回答 | **无容器**直接排版，`text-content`，内容优先；不加头像不加底色 |
| 过程聚合块 | `bg-surface border-line` 8px 圆角；**类型区分 = 左 3px 色条 + 专属图标**（思考 violet-400、工具 line-strong、子代理 accent）；头部为 chevron + 标签 + 计数 + 状态；展开区为**垂直时间线**（2px `line` 连接线 + 8px 节点圆点），工具卡/思考块作为时间线步骤存在，不再各自带边框 |
| 内嵌 pre（参数/结果） | `bg-inset`，6px 圆角，12px mono，`max-h` + 滚动 |
| 代码块 | 恒定 zinc-900 深底（浅色主题下即「深岛」，与 github-dark 高亮统一；深色主题下加 `border-line`）；右上角语言标签（11px，hover 区显现）+ 复制按钮；8px 圆角 |
| 元信息 chip（来源徽标 / trace 芯片） | 同族规范：11px、`border-line` hairline、6px 圆角、文本 `content-secondary`、hover 转 accent。来源徽标保留现有 chip 结构；trace 芯片（`Turn.tsx` TraceChip，PR #2）展示 traceId 前 8 位、点击复制完整 32 位 hex——`h-8`（32px 触达）、`tabular-nums`、`focus-visible` 已达标，保留。位置：完成轮并入答案元信息行尾（可 `flex-wrap` 换行），流式/异常/取消轮单独成行（运行中即可复制去罗盘检索） |
| Tooltip | 图标按钮的即时悬停提示（`components/Tooltip.tsx`）：反色 chip（`bg-content text-canvas`）11px、6px 圆角，hover / 键盘聚焦即现（`duration-fast` 淡入），`pointer-events-none` 不拦截指针；`placement` 默认 `bottom`，贴近视口/容器底部的控件（如侧栏底部主题切换）用 `"top"`；替代原生 title 的延迟与系统样式，SR 语义仍由控件 `aria-label` 承担 |
| 答案元信息行 | 正文底部（完成轮才展示）：复制回答（§7 复制反馈模式，`h-8 w-8` 触达，hover 高亮 `bg-content/10` + Tooltip）· `用量 N tok`（CUSTOM `run.usage`，≥1 万取整 K、千位一位小数）· 时间（恒为 `M月D日 HH:mm`，取 RUN_STARTED 事件时间戳）· 行尾可挂 trace 芯片（见上行）；12px `content-secondary`、`tabular-nums`，纯文本不带图标，`flex-wrap` 窄屏换行。图标按钮 hover 高亮统一 `bg-content/10`（主题无关；禁用 `bg-inset`——深色下与画布同色不可见） |
| Composer | 输入框 + 按钮同排 `gap-2`；输入 12px 圆角、`border-line`、focus 时 ring `accent`（2px，20% 透明度外扩）；底部 hint 12px `text-content-secondary`；发送钮 `bg-accent`，停止钮中性反色（`bg-content text-canvas`） |
| 错误条 | `danger` 12% tint 底 + danger 30% 边框 + danger 文本；重试为描边式按钮 |

**复制反馈（通用交互模式）**：点击复制类控件统一为——点击后文本切换「已复制」（配 SVG check 图标，见 §6），≤1.6s 自动回退原文，控件尺寸不变（无布局位移）。trace 芯片与代码块复制按钮（P2）共用此模式。

---

## 8. 动效

| Token | 值 | 用途 |
|---|---|---|
| `--duration-fast` | 150ms | hover、色彩/边框状态 |
| `--duration-base` | 200ms | 折叠展开、抽屉 |
| `--duration-enter` | 250ms | 内容入场 |

- 折叠展开用 `grid-template-rows: 0fr → 1fr` 过渡（禁止瞬时跳变与布局抖动）；chevron 旋转同步。
- 新消息/新块入场：`opacity 0→1` + `translateY(4px→0)`，`--duration-enter`，包裹 `motion-safe:`。
- 常驻动画（`animate-spin`/`animate-pulse`/流式光标）必须适配 `prefers-reduced-motion`（关停或降级为静态）。
- easing：进入 ease-out，退出 ease-in（出场比入场快）。
- 禁止：布局位移式 hover、弹跳、视差、>300ms 装饰动画。

---

## 9. 可访问性底线（每项 UI 变更必须过）

- [ ] 双主题正文对比 ≥4.5:1；informative 文本 ≥ `content-secondary`；`content-muted` 仅装饰
- [ ] 全局 `:focus-visible` 可见（`ring` 2px accent + offset）；键盘可达
- [ ] 触达目标 ≥32px（桌面 web），Composer 按钮保持 44px
- [ ] 折叠控件带 `aria-expanded`；状态点有文字或 `aria-label`；装饰图标 `aria-hidden`
- [ ] 错误提示可被读屏感知；`prefers-reduced-motion` 生效
- [ ] 双主题分别人工验证；375 / 768 / 1440px 三档验证

---

## 10. 反模式（禁止）

- ❌ emoji / 字符 dingbat（如 ✓）作结构性图标；第二强调色；渐变 / glassmorphism / 重阴影
- ❌ 组件层硬编码 `zinc-*` / `indigo-*`（只允许出现在 `index.css` token 定义处）
- ❌ informative 文本使用 `content-muted`；裸状态点无标签
- ❌ 深色模式直接复用浅色对比值（两主题分别校验）
- ❌ 瞬时跳变的展开/收起；布局位移式交互反馈

---

## 11. 落地路线（现状 → 规范的差距）

| 阶段 | 内容 |
|---|---|
| P0 | 对比度修复（§3.1 硬规则，含 TraceChip zinc-500）+ 全局 focus-visible + reduced-motion 适配（不依赖 token 层，可立即做） |
| P1 | `@theme` token 层（§2）→ 全组件切换语义类 → 深色模式 + 字体自托管接入 |
| P2 | 过程块时间线与类型色条（§7）+ 图标语义拆分/lucide 迁移（§6，含 TraceChip「已复制 ✓」字符换 SVG）+ 代码块语言标签与复制（复用复制反馈模式，§7）+ 微动效（§8） |
| P3 | 品牌 mark 替换「R」字母块 + 移动端抽屉侧栏 + 空态视觉增强 |

每阶段验证门槛：`pnpm typecheck && pnpm test`；涉及检索/评测的变更另见仓库根 `AGENTS.md` 评测纪律。
