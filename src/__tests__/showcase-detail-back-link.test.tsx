import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailBackLink from '@/app/showcase/[id]/ShowcaseDetailBackLink';

const routerBack = vi.fn();
let navigatedInThisDocument = true;

vi.mock('next/navigation', () => ({
    useRouter: () => ({ back: routerBack, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
    default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
        <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
    ),
}));

vi.mock('@/components/navigation-progress-state', () => ({
    hasNavigatedInThisDocument: () => navigatedInThisDocument,
}));

function setHistoryLength(value: number) {
    Object.defineProperty(window.history, 'length', { value, configurable: true });
}

function renderBackLink() {
    render(<ShowcaseDetailBackLink href="/feed" label="Back to Explore" />);
    return screen.getByRole('link', { name: /back to explore/i });
}

describe('ShowcaseDetailBackLink', () => {
    beforeEach(() => {
        routerBack.mockClear();
        navigatedInThisDocument = true;
        setHistoryLength(4);
    });

    afterEach(() => {
        cleanup();
    });

    it('is a real link to the return destination', () => {
        // Keeping it a link is what preserves the hover URL, "open in new tab",
        // and a sensible role for assistive tech.
        expect(renderBackLink()).toHaveAttribute('href', '/feed');
    });

    it('steps back in history when the viewer came from inside the app', () => {
        const link = renderBackLink();

        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(event);

        expect(routerBack).toHaveBeenCalledTimes(1);
        // Popping instead of following the href is what restores the feed's
        // scroll position and its already-paginated pages.
        expect(event.defaultPrevented).toBe(true);
    });

    it('is not drawn for someone who arrived by the post’s own address', () => {
        // A shared link, a refresh, a new tab: no page of the site is behind them, and
        // stepping back would take them out of the site (owner, 2026-11-15).
        navigatedInThisDocument = false;
        const { container } = render(<ShowcaseDetailBackLink href="/showcase" label="Back to Explore" />);

        expect(screen.queryByRole('link')).toBeNull();
        // Nor the row it sits in: no empty gap above the post.
        expect(container).toBeEmptyDOMElement();
    });

    it('keeps the answer it had as the page mounted', () => {
        // A navigation that starts as the reader leaves must not draw it under them.
        navigatedInThisDocument = false;
        const view = render(<ShowcaseDetailBackLink href="/showcase" label="Back" />);
        navigatedInThisDocument = true;
        view.rerender(<ShowcaseDetailBackLink href="/showcase" label="Back to Search" />);

        expect(screen.queryByRole('link')).toBeNull();
    });

    it('follows the href when there is no history entry to consume', () => {
        setHistoryLength(1);
        const link = renderBackLink();

        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(event);

        expect(routerBack).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it.each([
        ['cmd', { metaKey: true }],
        ['ctrl', { ctrlKey: true }],
        ['shift', { shiftKey: true }],
        ['alt', { altKey: true }],
    ])('leaves a %s-click to the browser', (_label, modifiers) => {
        const link = renderBackLink();

        fireEvent.click(link, { button: 0, ...modifiers });

        expect(routerBack).not.toHaveBeenCalled();
    });

    it('does not prefetch the destination', () => {
        // The feed the viewer is returning to is already in the router cache.
        expect(renderBackLink()).toHaveAttribute('data-prefetch', 'false');
    });
});
