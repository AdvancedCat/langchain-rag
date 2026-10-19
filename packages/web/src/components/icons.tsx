// 内联 SVG 图标（避免图标库依赖）
export function IconChevron({ open }: { open: boolean }) {
    return (
        <svg aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-content-muted transition-transform ${open ? 'rotate-90' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
        >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function IconWrench() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path
                d="M9.5 2.5a3.5 3.5 0 0 0-3.3 4.6L2 11.3 4.7 14l4.2-4.2a3.5 3.5 0 0 0 4.6-3.3l-2.3 1.2-1.9-1.9L10.5 3.5 9.5 2.5z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function IconBrain() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path
                d="M6.5 2.5c-1.5 0-2.5 1-2.5 2.3-1 .3-1.7 1.2-1.7 2.2 0 .8.4 1.5 1 1.9-.3.4-.5.9-.5 1.4 0 1.3 1.1 2.2 2.5 2.2.4.9 1.3 1.5 2.4 1.5V2.5h-1.2zM9.5 2.5c1.5 0 2.5 1 2.5 2.3 1 .3 1.7 1.2 1.7 2.2 0 .8-.4 1.5-1 1.9.3.4.5.9.5 1.4 0 1.3-1.1 2.2-2.5 2.2-.4.9-1.3 1.5-2.4 1.5V2.5h1.2z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function IconSpinner() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-accent" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

export function IconCheck() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-content-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function IconSend() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 8l12-5.5L9.5 14 8 9l-6-1z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function IconStop() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
            <rect x="4" y="4" width="8" height="8" rx="1.5" />
        </svg>
    );
}

export function IconTrash() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function IconPlus() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
    );
}

export function IconBot() {
    return (
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="3" y="5" width="10" height="8" rx="2" />
            <path d="M8 2.5V5M6 9h.01M10 9h.01" strokeLinecap="round" />
        </svg>
    );
}

export function IconSun() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3" />
            <path
                d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"
                strokeLinecap="round"
            />
        </svg>
    );
}

export function IconMoon() {
    return (
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" strokeLinejoin="round" />
        </svg>
    );
}
