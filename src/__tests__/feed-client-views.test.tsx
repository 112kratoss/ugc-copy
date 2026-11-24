import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import { flushPostViews, resetPostViewReporterForTests } from '@/app/showcase/post-view-reporter';
import { clearShowcaseClientCacheForTests } from '@/lib/showcase-client-cache';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

// The browser's session as Home reads it: still being checked, then known.
const auth = vi.hoisted(() => ({
    current: { session: null, user: null, isLoading: true } as {
        session: { access_token: string } | null;
        user: { id: string } | null;
        isLoading: boolean;
    },
}));

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => auth.current,
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

const POST_ID = '11111111-1111-4111-8111-111111111111';

const feed = {
    items: [{
        id: POST_ID,
        mediaUrl: null,
        mediaKind: null,
        model: 'external',
        title: 'A note',
        prompt: '',
        body: 'A note.',
        category: 'text',
        postFormat: 'text',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-11-20T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    } as ShowcaseFeedItem],
    pageInfo: { hasMore: false, nextOffset: null },
} as ShowcaseFeedPage;

describe('FeedClient views', () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        observers.length = 0;
        auth.current = { session: null, user: null, isLoading: true };
        clearShowcaseClientCacheForTests();
        resetPostViewReporterForTests();
        vi.stubGlobal('IntersectionObserver', class {
            private readonly observer: { callback: IntersectionObserverCallback; targets: Element[] };
            constructor(callback: IntersectionObserverCallback) {
                this.observer = { callback, targets: [] };
                observers.push(this.observer);
            }
            observe(target: Element) { this.observer.targets.push(target); }
            unobserve() {}
            disconnect() { this.observer.targets = []; }
            takeRecords() { return []; }
        });
        // Views are answered; the feed's own reads never are, so nothing else changes the page.
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
            String(input) === '/api/showcase/views'
                ? Promise.resolve(new Response(null, { status: 204 }))
                : new Promise(() => undefined)
        )));
    });

    afterEach(() => {
        cleanup();
        resetPostViewReporterForTests();
        clearShowcaseClientCacheForTests();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function viewsSent() {
        await act(async () => { await flushPostViews(); });
        return vi.mocked(fetch).mock.calls
            .filter(([input]) => String(input) === '/api/showcase/views')
            .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { views: Array<{ postId: string; surface: string }> });
    }

    it('holds a card’s view while the session is read, and sends it once the session is known', async () => {
        const { rerender } = render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        const card = document.querySelector(`[data-showcase-post-id="${POST_ID}"]`);
        expect(card, 'the card sits in its impression boundary').not.toBeNull();
        const observer = observers.find((candidate) => candidate.targets.includes(card!));
        expect(observer, 'the card is watched').toBeDefined();

        act(() => {
            observer!.callback([{ target: card!, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        act(() => { vi.advanceTimersByTime(2_000); });
        expect(await viewsSent()).toEqual([]);

        auth.current = { session: null, user: null, isLoading: false };
        rerender(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        expect(await viewsSent()).toEqual([{ views: [{ postId: POST_ID, surface: 'feed' }] }]);
    });
});
