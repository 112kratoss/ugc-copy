import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/components/FeedbackViewport';
import NavigationProgress from '@/components/NavigationProgress';
import { requestConfirmation, resetFeedbackState } from '@/components/feedback-state';
import { publishNavigationStart } from '@/components/navigation-progress-state';

let mockedPathname = '/feed';

vi.mock('next/navigation', () => ({
  usePathname: () => mockedPathname,
}));

function bar() {
  return screen.queryByTestId('navigation-progress');
}

describe('NavigationProgress', () => {
    beforeEach(() => {
        mockedPathname = '/feed';
        window.history.replaceState(null, '', '/feed');
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('renders nothing until something navigates', () => {
        render(<NavigationProgress />);

        expect(bar()).toBeNull();
    });

    it('renders nothing on the server, so the first client paint matches', () => {
        // A bar present in the server HTML but absent after hydration (or the
        // reverse) is a hydration mismatch, which the app shell tests treat as a
        // hard failure.
        expect(renderToString(<NavigationProgress />)).toBe('');
    });

    it('appears as soon as an imperative navigation is announced', () => {
        render(<NavigationProgress />);

        act(() => publishNavigationStart());

        expect(bar()).toBeInTheDocument();
    });

    it('grows while the next page is still loading', () => {
        vi.useFakeTimers();
        render(<NavigationProgress />);
        act(() => publishNavigationStart());

        const initial = bar()!.firstElementChild as HTMLElement;
        const startWidth = Number.parseFloat(initial.style.width);

        act(() => { vi.advanceTimersByTime(400); });

        const grownWidth = Number.parseFloat(
            (bar()!.firstElementChild as HTMLElement).style.width
        );
        expect(grownWidth).toBeGreaterThan(startWidth);
        // It must never claim to be finished while it is still waiting.
        expect(grownWidth).toBeLessThan(100);
    });

    it('completes and disappears once the new path renders', () => {
        vi.useFakeTimers();
        const { rerender } = render(<NavigationProgress />);
        act(() => publishNavigationStart());
        expect(bar()).toBeInTheDocument();

        mockedPathname = '/showcase/post-1';
        rerender(<NavigationProgress />);
        act(() => { vi.advanceTimersByTime(1000); });

        expect(bar()).toBeNull();
    });

    it('gives up rather than spinning forever when a navigation never lands', () => {
        vi.useFakeTimers();
        render(<NavigationProgress />);
        act(() => publishNavigationStart());

        act(() => { vi.advanceTimersByTime(13_000); });

        expect(bar()).toBeNull();
    });

    it('raises the bar for an ordinary in-app link click', () => {
        render(
            <>
                <NavigationProgress />
                {/* A raw anchor on purpose: the component listens at the document
                    for any internal link, which is what lets one instance cover
                    every navigation without touching each link. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/showcase/post-1">Open post</a>
            </>
        );

        fireEvent.click(screen.getByText('Open post'));

        expect(bar()).toBeInTheDocument();
    });

    it.each([
        ['a bare hash on the current page', { href: '/feed#top' }],
        ['a link that opens a new tab', { href: '/showcase/post-1', target: '_blank' }],
        ['a cross-origin link', { href: 'https://example.com/post' }],
        ['a download', { href: '/showcase/post-1', download: '' }],
    ])('stays hidden for %s', (_label, attrs) => {
        render(
            <>
                <NavigationProgress />
                <a {...attrs}>Not a navigation</a>
            </>
        );

        fireEvent.click(screen.getByText('Not a navigation'));

        expect(bar()).toBeNull();
    });

    it('stays hidden for a cmd-click, which the browser handles itself', () => {
        render(
            <>
                <NavigationProgress />
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/showcase/post-1">Open post</a>
            </>
        );

        fireEvent.click(screen.getByText('Open post'), { metaKey: true });

        expect(bar()).toBeNull();
    });

    it('is hidden from assistive tech, which already announces route changes', () => {
        render(<NavigationProgress />);
        act(() => publishNavigationStart());

        expect(bar()).toHaveAttribute('aria-hidden', 'true');
        // An invented percentage is worse than silence.
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    // The composer's Back link and the profile editor's leave guard hold the
    // click and ask; the bar crept over the question and on after a "stay".
    describe('a link that asks before it goes', () => {
        afterEach(() => {
            resetFeedbackState();
        });

        function renderGuardedLink() {
            render(
                <>
                    <NavigationProgress />
                    <FeedbackViewport />
                    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                    <a
                        href="/showcase/post-1"
                        onClick={(event) => {
                            event.preventDefault();
                            void requestConfirmation({ title: 'Leave this post?', message: 'Unsaved.', confirmLabel: 'Leave' })
                                .then((confirmed) => {
                                    if (confirmed) publishNavigationStart();
                                });
                        }}
                    >
                        Back to Explore
                    </a>
                </>
            );
        }

        it('takes the bar down while the question is up, and keeps it down after a "stay"', async () => {
            renderGuardedLink();

            fireEvent.click(screen.getByText('Back to Explore'));

            expect(screen.getByRole('alertdialog', { name: 'Leave this post?' })).toBeInTheDocument();
            expect(bar()).toBeNull();

            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 300));
            });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(bar()).toBeNull();
        });

        it('raises it again for a "leave", which announces its own navigation', async () => {
            renderGuardedLink();

            fireEvent.click(screen.getByText('Back to Explore'));
            fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
            await act(async () => {});

            expect(bar()).toBeInTheDocument();
        });
    });
});
