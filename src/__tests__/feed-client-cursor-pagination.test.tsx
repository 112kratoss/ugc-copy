import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import { clearShowcaseClientCacheForTests } from '@/lib/showcase-client-cache';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

vi.mock('@/app/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/app/components/navigation-progress-state', () => ({
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

function page(
    items: ShowcaseFeedItem[],
    pageInfo: { nextOffset: number | null; nextCursor?: string | null },
): ShowcaseFeedPage {
    return {
        items,
        pageInfo: {
            hasMore: pageInfo.nextOffset !== null || Boolean(pageInfo.nextCursor),
            ...pageInfo,
        },
    } as ShowcaseFeedPage;
}

let intersect: (() => void) | null = null;
let observerIntersections: Array<() => void> = [];

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('FeedClient cursor pagination', () => {
    beforeEach(() => {
        clearShowcaseClientCacheForTests();
        intersect = null;
        observerIntersections = [];
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback: IntersectionObserverCallback) {
                const triggerIntersection = () => callback(
                    [{ isIntersecting: true } as IntersectionObserverEntry],
                    this as unknown as IntersectionObserver,
                );
                observerIntersections.push(triggerIntersection);
                intersect = triggerIntersection;
            }
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() { return []; }
        });
    });

    afterEach(() => {
        cleanup();
        clearShowcaseClientCacheForTests();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('continues a ranked lane by cursor instead of re-ranking at an offset', async () => {
        // Offset alone re-runs the whole ranking whenever the page is loaded
        // outside the server's two-minute session-reuse window, persisting a new
        // session plus up to 120 more rows for every page.
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify(page([item('post-3')], { nextOffset: null, nextCursor: null })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient
            initialFeed={page([item('post-1'), item('post-2')], { nextOffset: 2, nextCursor: 'rank-cursor-1' })}
            initialChipId="for-you"
        />);

        intersect?.();

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url] = requestedUrls(fetchMock);
        expect(url).toContain('cursor=rank-cursor-1');
        // Either/or: an offset alongside the cursor is dead weight the server
        // zeroes anyway, and it makes a request log ambiguous.
        expect(url).not.toContain('offset=');
        await waitFor(() => expect(screen.getByText('card:post-3')).toBeInTheDocument());
    });

    it('still pages by offset when the lane produces no cursor', async () => {
        // Non-ranked sorts have no ranking to continue, so nothing changes.
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify(page([item('post-3')], { nextOffset: null })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient
            initialFeed={page([item('post-1'), item('post-2')], { nextOffset: 2 })}
            initialChipId="for-you"
        />);

        intersect?.();

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url] = requestedUrls(fetchMock);
        expect(url).toContain('offset=2');
        expect(url).not.toContain('cursor=');
    });

    it('carries the cursor forward across successive pages', async () => {
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify(page([item('post-3')], { nextOffset: 4, nextCursor: 'rank-cursor-2' })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient
            initialFeed={page([item('post-1'), item('post-2')], { nextOffset: 2, nextCursor: 'rank-cursor-1' })}
            initialChipId="for-you"
        />);

        intersect?.();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByText('card:post-3')).toBeInTheDocument());

        intersect?.();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        // The second page continues from the cursor the first page returned, not
        // from the one the server rendered with.
        expect(requestedUrls(fetchMock)[1]).toContain('cursor=rank-cursor-2');
    });

    it('cannot reuse the previous ranked cursor while replacing the lane', async () => {
        let resolveRecentLane: (response: Response) => void = () => undefined;
        const recentLane = new Promise<Response>((resolve) => {
            resolveRecentLane = resolve;
        });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('sort=recent') && url.includes('offset=0')) return recentLane;
            return new Response(
                JSON.stringify(page([item('wrong-continuation')], { nextOffset: null })),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<FeedClient
            initialFeed={page(
                [item('post-1'), item('post-2')],
                { nextOffset: 2, nextCursor: 'old-ranked-cursor' },
            )}
            initialChipId="for-you"
        />);

        fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        // A queued observer notification from the lane being left must not
        // interrupt the replacement request, even if it arrives before React
        // finishes disconnecting that observer.
        act(() => {
            for (const triggerIntersection of observerIntersections) triggerIntersection();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(requestedUrls(fetchMock)[0]).not.toContain('old-ranked-cursor');

        resolveRecentLane(new Response(
            JSON.stringify(page([item('recent-post')], { nextOffset: null })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        expect(await screen.findByText('card:recent-post')).toBeInTheDocument();
        expect(screen.queryByText('card:wrong-continuation')).not.toBeInTheDocument();
    });
});
