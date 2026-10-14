import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

interface CardRender {
    card: { id: string; title: string; item: ShowcaseFeedItem };
    onCommentCountChange: (postId: string, commentCount: number) => void;
}

const { router, cardRenders } = vi.hoisted(() => ({
    router: { push: () => undefined },
    cardRenders: [] as CardRender[],
}));

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => router,
}));

vi.mock('@/app/feed/FeedPostCard', () => ({
    default: (props: CardRender) => {
        cardRenders.push(props);
        return <article>{props.card.title}</article>;
    },
}));

function item(id: string, title: string): ShowcaseFeedItem {
    return {
        id,
        mediaUrl: null,
        mediaKind: null,
        model: 'external',
        title,
        prompt: '',
        body: '',
        category: 'text',
        postFormat: 'text',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-07-28T00:00:00.000Z',
        creator: {
            id: 'creator-1',
            username: 'creator',
            name: 'Creator',
            avatar: null,
        },
        isSaved: false,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    };
}

function feed(
    items: ShowcaseFeedItem[],
    pageInfo: Partial<ShowcaseFeedPage['pageInfo']> = {}
): ShowcaseFeedPage {
    return {
        items,
        pageInfo: {
            hasMore: false,
            nextOffset: null,
            limit: 12,
            offset: 0,
            ...pageInfo,
        },
    };
}

describe('FeedClient request ordering', () => {
    let observerCallback: IntersectionObserverCallback | null;

    beforeEach(() => {
        observerCallback = null;
        vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(
            callback: IntersectionObserverCallback
        ) {
            observerCallback = callback;
            return {
                root: null,
                rootMargin: '600px 0px',
                thresholds: [0],
                observe: vi.fn(),
                unobserve: vi.fn(),
                disconnect: vi.fn(),
                takeRecords: vi.fn(() => []),
            } satisfies IntersectionObserver;
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lets a lane switch supersede an in-flight pagination request', async () => {
        let resolveOldPage: (response: Response) => void = () => undefined;
        const oldPage = new Promise<Response>((resolve) => {
            resolveOldPage = resolve;
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('sort=recent') && url.includes('offset=0')) {
                return new Response(JSON.stringify(feed([item('recent', 'Recent lane post')])), {
                    status: 200,
                });
            }
            return oldPage;
        });
        vi.stubGlobal('fetch', fetchMock);

        render(
            <FeedClient
                // A ranked page names its session; one without would first be
                // read again for the guest, before any paging.
                initialFeed={{
                    ...feed([item('initial', 'Initial post')], { hasMore: true, nextOffset: 12 }),
                    feedSessionId: 'ranked-session',
                }}
                initialChipId="for-you"
            />
        );

        expect(screen.getByText('Initial post')).toBeInTheDocument();
        await waitFor(() => expect(observerCallback).not.toBeNull());

        act(() => {
            observerCallback?.([{
                isIntersecting: true,
                target: document.body,
            } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
        expect(await screen.findByText('Recent lane post')).toBeInTheDocument();

        resolveOldPage(new Response(JSON.stringify(feed([item('stale', 'Stale old page')]))));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.queryByText('Stale old page')).not.toBeInTheDocument();
        expect(screen.getByText('Recent lane post')).toBeInTheDocument();
    });
});

describe('FeedClient comment counts', () => {
    beforeEach(() => {
        cardRenders.length = 0;
        vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock() {
            return {
                root: null,
                rootMargin: '0px',
                thresholds: [0],
                observe: vi.fn(),
                unobserve: vi.fn(),
                disconnect: vi.fn(),
                takeRecords: vi.fn(() => []),
            } satisfies IntersectionObserver;
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed([])))));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // 04-8: an open thread publishes its count after every page it loads.
    it('hands the feed a new array only when a thread reports a different count', () => {
        render(
            <FeedClient
                initialFeed={feed([
                    { ...item('first', 'First post'), commentCount: 2 },
                    item('second', 'Second post'),
                ])}
                initialChipId="for-you"
            />
        );
        const latest = (id: string) => cardRenders.findLast((entry) => entry.card.id === id);
        const first = latest('first');
        expect(first?.card.item.commentCount).toBe(2);

        act(() => first?.onCommentCountChange('first', 2));
        // The cards are built from the items array; the same card means the
        // feed kept the same array and no card had to rebuild.
        expect(latest('first')?.card).toBe(first?.card);
        expect(latest('second')?.card.item.commentCount).toBe(0);

        act(() => first?.onCommentCountChange('first', 3));
        expect(latest('first')?.card).not.toBe(first?.card);
        expect(latest('first')?.card.item.commentCount).toBe(3);
    });
});
