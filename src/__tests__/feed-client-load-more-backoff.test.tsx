import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import { clearShowcaseClientCacheForTests } from '@/lib/showcase-client-cache';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/components/navigation-progress-state', () => ({
    publishNavigationStart: vi.fn(),
}));

vi.mock('@/app/feed/FeedPostCard', () => ({
    default: ({ card }: { card: { id: string } }) => <article>{`card:${card.id}`}</article>,
}));

function item(id: string): ShowcaseFeedItem {
    return {
        id,
        mediaUrl: null,
        mediaKind: null,
        model: 'external',
        title: id,
        prompt: '',
        body: '',
        category: 'text',
        postFormat: 'text',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
        isSaved: false,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    } as ShowcaseFeedItem;
}

/** A failure the way a network gives one: after a little while, so the page draws its loading state first. */
async function failedAfter(ms = 40) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response('{}', { status: 503 });
}

function page(items: ShowcaseFeedItem[], nextOffset: number | null): ShowcaseFeedPage {
    return {
        items,
        pageInfo: { hasMore: nextOffset !== null, nextOffset },
    } as ShowcaseFeedPage;
}

/**
 * Moves the clock in small steps, each its own act(), so the page renders and
 * runs its effects between the network's answers as a browser does. One act()
 * around the whole span would hold every render to its end.
 */
async function advance(ms: number, step = 20) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed)); });
    }
}

describe('FeedClient: a failed Load more does not ask again in a loop', () => {
    beforeEach(() => {
        clearShowcaseClientCacheForTests();
        vi.useFakeTimers();
        // As a browser does: an observer reports the sentinel's state as soon as
        // it observes it, and the sentinel sits within the 600 px margin.
        vi.stubGlobal('IntersectionObserver', class {
            private readonly callback: IntersectionObserverCallback;
            private disconnected = false;
            constructor(callback: IntersectionObserverCallback) {
                this.callback = callback;
            }
            observe() {
                queueMicrotask(() => {
                    if (this.disconnected) return;
                    this.callback(
                        [{ isIntersecting: true } as IntersectionObserverEntry],
                        this as unknown as IntersectionObserver,
                    );
                });
            }
            unobserve() {}
            disconnect() { this.disconnected = true; }
            takeRecords() { return []; }
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // Recent: no guest page one to read again, so every request here is Load more.
        window.history.replaceState(null, '', '/?chip=recent');
    });

    afterEach(() => {
        cleanup();
        clearShowcaseClientCacheForTests();
        window.history.replaceState(null, '', '/');
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('waits before asking again after a failure, longer each time, then leaves it to Retry', async () => {
        const fetchMock = vi.fn(() => failedAfter());
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient initialFeed={page([item('post-1'), item('post-2')], 2)} initialChipId="recent" />);

        // The production loop sent 225 failing requests in 5.5 s (speed baseline,
        // 2026-11-19): every failure re-created the observer, which fired at once.
        await advance(1_500);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await advance(1_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await advance(8_100);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await advance(120_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Could not load more posts.');
        // Told at the end of the list, where the reader is, not above the posts.
        const lastCard = screen.getByText('card:post-2');
        expect(lastCard.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // The person can always ask again.
        fetchMock.mockImplementation(async () => new Response(
            JSON.stringify(page([item('post-3')], null)),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
            await vi.advanceTimersByTimeAsync(50);
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(screen.getByText('card:post-3')).toBeInTheDocument();
        expect(String((fetchMock.mock.calls[3] as unknown[])[0])).toContain('offset=2');
    });

    it('starts over after a page loads: the next failure waits the first delay again', async () => {
        let call = 0;
        const fetchMock = vi.fn(async () => {
            call += 1;
            if (call === 2) {
                return new Response(
                    JSON.stringify(page([item('post-3')], 3)),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            return failedAfter();
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient initialFeed={page([item('post-1'), item('post-2')], 2)} initialChipId="recent" />);

        await advance(100);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The retry after 2 s loads a page; the next page is asked at once.
        await advance(2_100);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(String((fetchMock.mock.calls[2] as unknown[])[0])).toContain('offset=3');
        // That one fails: the wait is the first one again (2 s), not the second (8 s).
        await advance(1_600);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await advance(800);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('asks again when the network comes back after the retries ran out, with its retries anew', async () => {
        const fetchMock = vi.fn(() => failedAfter());
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient initialFeed={page([item('post-1'), item('post-2')], 2)} initialChipId="recent" />);
        await advance(12_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await act(async () => { window.dispatchEvent(new Event('online')); });
        await advance(100);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        // And it waits 2 s again after that one fails, not Retry at once.
        await advance(2_100);
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });
});
