import type { ReactNode } from 'react';

type Placement = 'top' | 'bottom' | 'left';

/** label 相对被包裹控件的定位；居中轴 top/bottom 为水平、left 为垂直 */
const PLACEMENT_CLASS: Record<Placement, string> = {
    bottom: 'left-1/2 top-full mt-1.5 -translate-x-1/2',
    top: 'left-1/2 bottom-full mb-1.5 -translate-x-1/2',
    left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
};

/**
 * 即时悬停提示（替代原生 title 的 ~1s 延迟与系统样式）：
 * 反色 chip（bg-content text-canvas），hover / 键盘聚焦即现（150ms 淡入），
 * 不拦截指针；SR 语义仍由被包裹控件的 aria-label 承担，视觉层 aria-hidden。
 *
 * label 绝对定位，会被任何 overflow 祖先裁切：贴近视口/容器底部的控件用
 * placement="top"（侧栏底部主题切换）；纵向滚动容器内的控件用 placement="left"，
 * label 与控件同一水平线、避开滚动口的上下边界（侧栏会话行的删除按钮）。
 * 触屏无 hover 不会显示，控件自身的 aria-label 是唯一兜底。
 */
export function Tooltip({
    label,
    placement = 'bottom',
    className,
    children,
}: {
    label: string;
    placement?: Placement;
    /** 附加到外层包装 span（Tooltip 是 flex 容器的直接子元素，auto 边距等布局属性应加在这里） */
    className?: string;
    children: ReactNode;
}) {
    return (
        <span className={`group/tt relative inline-flex ${className ?? ''}`}>
            {children}
            <span
                aria-hidden="true"
                className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-content px-2 py-1 text-[11px] font-medium leading-none text-canvas opacity-0 transition-opacity duration-fast group-hover/tt:opacity-100 group-focus-within/tt:opacity-100 ${PLACEMENT_CLASS[placement]}`}
            >
                {label}
            </span>
        </span>
    );
}
