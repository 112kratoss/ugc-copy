'use client';

import { ArrowUp } from 'lucide-react';

/**
 * "New posts": newer posts exist than the lane the reader holds (D2,
 * 2026-10-14). Nothing is swapped under the reader: the tap is the one way
 * they load, through the screen's own refresh. A button in the page's order,
 * so a keyboard reaches it; its entrance is the shared pop, which the
 * reduced-motion rule in globals.css stills.
 */
export default function NewPostsPill({
    onPress,
    className = '',
}: {
    onPress: () => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onPress}
            className={`ui-focus-ring ui-enter-pop inline-flex min-h-11 origin-top items-center gap-2 rounded-full border border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition hover:bg-[var(--ui-primary-strong)] ${className}`}
        >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
            New posts
        </button>
    );
}

/** The way back to the top of the lane: smooth, unless the reader asks for reduced motion. */
export function newPostsScrollBehavior(): ScrollBehavior {
    const reducedMotion = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reducedMotion ? 'auto' : 'smooth';
}
