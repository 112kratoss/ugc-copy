import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

vi.mock('@/app/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/app/feed/FeedPostCard', () => ({
    default: ({ card }: { card: { title: string } }) => <article>{card.title}</article>,
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
                initialFeed={feed(
                    [item('initial', 'Initial post')],
                    { hasMore: true, nextOffset: 12 }
                )}
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
