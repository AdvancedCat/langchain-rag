import type { ReactNode } from 'react';

/**
 * 即时悬停提示（替代原生 title 的 ~1s 延迟与系统样式）：
 * 反色 chip（bg-content text-canvas），hover / 键盘聚焦即现（150ms 淡入），
 * 不拦截指针；SR 语义仍由被包裹控件的 aria-label 承担，视觉层 aria-hidden。
 * 贴近视口/容器底部的控件用 placement="top"（如侧栏底部主题切换）。
 */
export function Tooltip({
    label,
    placement = 'bottom',
    children,
}: {
    label: string;
    placement?: 'top' | 'bottom';
    children: ReactNode;
}) {
    return (
        <span className="group/tt relative inline-flex">
            {children}
            <span
                aria-hidden="true"
                className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-content px-2 py-1 text-[11px] font-medium leading-none text-canvas opacity-0 transition-opacity duration-fast group-hover/tt:opacity-100 group-focus-within/tt:opacity-100 ${
                    placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
                }`}
            >
                {label}
            </span>
        </span>
    );
}
