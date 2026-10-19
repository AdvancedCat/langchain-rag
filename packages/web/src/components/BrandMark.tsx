/**
 * 品牌 mark（MASTER §11 P3）：「文档 + 检索」几何字形，替换 R 字母块。
 * currentColor 着色——放在 bg-accent 容器内即呈 accent-fg 色。
 */
export function BrandMark({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M9.3 2H4.8A1.8 1.8 0 0 0 3 3.8v8.4A1.8 1.8 0 0 0 4.8 14h6.4a1.8 1.8 0 0 0 1.8-1.8V5.7L9.3 2Z" />
            <path d="M9.3 2v3.7H13" />
            <path d="M5.5 8.1h1.8" />
            <circle cx="8.8" cy="10" r="1.7" />
            <path d="M10.1 11.3l1.2 1.2" />
        </svg>
    );
}
