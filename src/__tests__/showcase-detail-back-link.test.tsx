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

vi.mock('@/app/components/navigation-progress-state', () => ({
    hasNavigatedInThisDocument: () => navigatedInThisDocument,
}));

function setHistoryLength(value: number) {
    Object.defineProperty(window.history, 'length', { value, configurable: true });
}

function renderBackLink() {
    render(<ShowcaseDetailBackLink href="/feed" label="Back to Community" />);
    return screen.getByRole('link', { name: /back to community/i });
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

    it('follows the href for someone who arrived from a shared link', () => {
        navigatedInThisDocument = false;
        const link = renderBackLink();

        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(event);

        // Stepping back here would take them out of the app entirely.
        expect(routerBack).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
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
