// 图标统一走 lucide-react（MASTER §6）：16px 网格线性、strokeWidth 1.5、currentColor；
// 尺寸约定：行内 14px（h-3.5）、按钮内 16px（h-4）。
// 语义规则：每类过程块一个专属图标——思考 Brain、工具 Wrench、子代理 Bot、聚合 Workflow。
import type { LucideProps } from 'lucide-react';
import {
    Bot,
    Brain,
    Check,
    ChevronRight,
    Copy,
    LoaderCircle,
    Moon,
    Plus,
    Send,
    Square,
    Sun,
    Trash2,
    Workflow,
    Wrench,
} from 'lucide-react';

function withDefaults(props: LucideProps): LucideProps {
    return { 'aria-hidden': true, strokeWidth: 1.5, ...props };
}

export function IconChevron({ open }: { open: boolean }) {
    // 旋转与折叠过渡同步（--duration-base，MASTER §8）
    return (
        <ChevronRight
            {...withDefaults({
                className: `h-3.5 w-3.5 shrink-0 text-content-muted motion-safe:transition-transform motion-safe:duration-base ${open ? 'rotate-90' : ''}`,
            })}
        />
    );
}

export function IconWrench() {
    return <Wrench {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0' })} />;
}

export function IconBrain() {
    return <Brain {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0' })} />;
}

/** 聚合块专属图标（与思考块 Brain 拆分，禁止一图两义） */
export function IconWorkflow() {
    return <Workflow {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0' })} />;
}

export function IconSpinner() {
    return <LoaderCircle {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-accent' })} />;
}

export function IconCheck({ className = 'h-3.5 w-3.5 shrink-0 text-content-muted' }: { className?: string }) {
    return <Check {...withDefaults({ className })} />;
}

export function IconSend() {
    return <Send {...withDefaults({ className: 'h-4 w-4' })} />;
}

export function IconStop() {
    return <Square {...withDefaults({ className: 'h-3.5 w-3.5', fill: 'currentColor' })} />;
}

export function IconTrash() {
    return <Trash2 {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0' })} />;
}

export function IconPlus() {
    return <Plus {...withDefaults({ className: 'h-4 w-4' })} />;
}

export function IconBot() {
    return <Bot {...withDefaults({ className: 'h-3.5 w-3.5 shrink-0' })} />;
}

export function IconSun() {
    return <Sun {...withDefaults({ className: 'h-4 w-4' })} />;
}

export function IconMoon() {
    return <Moon {...withDefaults({ className: 'h-4 w-4' })} />;
}

export function IconCopy() {
    return <Copy {...withDefaults({ className: 'h-3.5 w-3.5' })} />;
}
