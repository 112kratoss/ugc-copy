import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailBackLink from '@/app/showcase/[id]/ShowcaseDetailBackLink';

const routerBack = vi.fn();
// A link click (or a push that announces itself) has been counted in this document.
let navigatedInThisDocument = true;
// The post is not the page the document was loaded at: a client navigation of any
// kind brought the viewer here.
let reachedInThisDocument = true;

vi.mock('next/navigation', () => ({
    useRouter: () => ({ back: routerBack, push: vi.fn(), replace: vi.fn() }),
    usePathname: () => '/showcase/post-1',
}));

vi.mock('next/link', () => ({
    default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
        <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
    ),
}));

vi.mock('@/components/navigation-progress-state', () => ({
    hasNavigatedInThisDocument: () => navigatedInThisDocument,
    isPageReachedInThisDocument: (pathname: string) => pathname === '/showcase/post-1' && reachedInThisDocument,
}));

function setHistoryLength(value: number) {
    Object.defineProperty(window.history, 'length', { value, configurable: true });
}

function renderBackLink() {
    render(<ShowcaseDetailBackLink href="/feed" label="Back to Explore" />);
    return screen.getByRole('link', { name: /back to explore/i });
}

function plainClick(link: HTMLElement) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    return event;
}

describe('ShowcaseDetailBackLink', () => {
    beforeEach(() => {
        routerBack.mockClear();
        navigatedInThisDocument = true;
        reachedInThisDocument = true;
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
        const event = plainClick(renderBackLink());

        expect(routerBack).toHaveBeenCalledTimes(1);
        // Popping instead of following the href is what restores the feed's
        // scroll position and its already-paginated pages.
        expect(event.defaultPrevented).toBe(true);
    });

    it('is not drawn on the page the document was loaded at', () => {
        // A shared link, a refresh, a new tab, or the browser's Back to that first
        // page after a link click elsewhere: no page of the site is behind the reader,
        // and stepping back would take them out of the site (owner, 2026-11-15).
        reachedInThisDocument = false;
        const { container } = render(<ShowcaseDetailBackLink href="/showcase" label="Back to Explore" />);

        expect(screen.queryByRole('link')).toBeNull();
        // Nor the row it sits in: no empty gap above the post.
        expect(container).toBeEmptyDOMElement();
    });

    it('keeps the answer it had as the page mounted', () => {
        // A navigation that starts as the reader leaves must not draw it under them.
        reachedInThisDocument = false;
        const view = render(<ShowcaseDetailBackLink href="/showcase" label="Back" />);
        reachedInThisDocument = true;
        view.rerender(<ShowcaseDetailBackLink href="/showcase" label="Back to Search" />);

        expect(screen.queryByRole('link')).toBeNull();
    });

    it('is drawn for a post the router opened with no link click counted, and then opens the page it names', () => {
        // Review of #829: an alert's tap or the composer's Publish (`router.replace`)
        // after the first page counted no navigation, and the post drew no way back.
        // After a replace there is no page of the site to step back to, so the href
        // opens the named page rather than leaving the site.
        navigatedInThisDocument = false;
        const event = plainClick(renderBackLink());

        expect(routerBack).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('decides at mount, so the press that NavigationProgress counts first cannot make it step back', () => {
        // NavigationProgress listens on the document in the capture phase and counts a
        // press on this link as a navigation before the link's own handler runs. Read at
        // the press, the count was never 0, and "Back to Home" after a replace stepped
        // out of the site (the E2E saw about:blank).
        navigatedInThisDocument = false;
        const link = renderBackLink();
        const countThePress = () => { navigatedInThisDocument = true; };
        document.addEventListener('click', countThePress, true);
        try {
            const event = plainClick(link);

            expect(routerBack).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        } finally {
            document.removeEventListener('click', countThePress, true);
        }
    });

    it('follows the href when there is no history entry to consume', () => {
        setHistoryLength(1);
        const event = plainClick(renderBackLink());

        expect(routerBack).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('draws a plain Back, which names no page, only where it steps back inside the site', () => {
        navigatedInThisDocument = false;
        const hidden = render(<ShowcaseDetailBackLink href="/showcase" label="Back" stepsBackOnly />);
        expect(hidden.container).toBeEmptyDOMElement();
        hidden.unmount();

        setHistoryLength(1);
        navigatedInThisDocument = true;
        const lone = render(<ShowcaseDetailBackLink href="/showcase" label="Back" stepsBackOnly />);
        expect(lone.container).toBeEmptyDOMElement();
        lone.unmount();

        setHistoryLength(4);
        render(<ShowcaseDetailBackLink href="/showcase" label="Back" stepsBackOnly />);
        const event = plainClick(screen.getByRole('link', { name: 'Back' }));
        expect(routerBack).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
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
