import type { ReactNode } from 'react';

/**
 * 即时悬停提示（替代原生 title 的 ~1s 延迟与系统样式）：
 * 反色 chip（bg-content text-canvas），hover / 键盘聚焦即现（150ms 淡入），
 * 不拦截指针；SR 语义仍由被包裹控件的 aria-label 承担，视觉层 aria-hidden。
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
    return (
        <span className="group/tt relative inline-flex">
            {children}
            <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-content px-2 py-1 text-[11px] font-medium leading-none text-canvas opacity-0 transition-opacity duration-fast group-hover/tt:opacity-100 group-focus-within/tt:opacity-100"
            >
                {label}
            </span>
        </span>
    );
}
