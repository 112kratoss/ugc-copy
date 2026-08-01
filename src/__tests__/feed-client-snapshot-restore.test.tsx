import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import {
    buildShowcaseClientCacheKey,
    clearShowcaseClientCacheForTests,
    writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
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
    default: ({ card }: { card: { id: string; title: string; isSaved?: boolean } }) => (
        <article>{`card:${card.id}`}</article>
    ),
}));

function item(id: string, isSaved = false): ShowcaseFeedItem {
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
        createdAt: '2026-07-28T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
        isSaved,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    } as ShowcaseFeedItem;
}

function page(items: ShowcaseFeedItem[], nextOffset: number | null): ShowcaseFeedPage {
    return {
        items,
        pageInfo: { hasMore: nextOffset !== null, nextOffset },
    } as ShowcaseFeedPage;
}

/** The server's first page: what a cold load renders. */
const serverPage = page([item('post-1'), item('post-2')], 2);

function homeFeedCacheKey() {
    return buildShowcaseClientCacheKey({
        surface: 'home-feed',
        viewerId: null,
        category: 'all',
        sort: 'for-you',
        tool: null,
        unlock: 'all',
        resource: 'all',
    });
}

describe('FeedClient snapshot restore', () => {
    beforeEach(() => {
        clearShowcaseClientCacheForTests();
        // jsdom has no IntersectionObserver, and a page that still has more to load
        // builds one. Never intersects, so nothing here auto-paginates.
        vi.stubGlobal('IntersectionObserver', class {
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
    });

    it('renders the server page when nothing has been cached yet', () => {
        render(<FeedClient initialFeed={serverPage} initialChipId="for-you" />);

        expect(screen.getAllByText(/^card:/)).toHaveLength(2);
    });

    it('restores pages loaded before the reader opened a post', () => {
        // Opening a post unmounts the feed; without this the reader comes back to
        // page one and loses their place.
        writeShowcaseClientSnapshot(homeFeedCacheKey(), {
            feed: page([item('post-1'), item('post-2'), item('post-3'), item('post-4')], null),
            renderedItemCount: 4,
            savedItemIds: [],
        });

        render(<FeedClient initialFeed={serverPage} initialChipId="for-you" />);

        expect(screen.getAllByText(/^card:/)).toHaveLength(4);
        expect(screen.getByText('card:post-4')).toBeTruthy();
    });

    it('writes a snapshot for later restores', () => {
        render(<FeedClient initialFeed={serverPage} initialChipId="for-you" />);

        const stored = window.sessionStorage.getItem(
            `magicbooklet:showcase:v2:${homeFeedCacheKey()}`
        );
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored!).feed.items).toHaveLength(2);
    });

    it('ignores a snapshot that is no larger than the server page', () => {
        // A stale single-page snapshot must not shadow a fresher server render.
        writeShowcaseClientSnapshot(homeFeedCacheKey(), {
            feed: page([item('old-1'), item('old-2')], null),
            renderedItemCount: 2,
            savedItemIds: [],
        });

        render(<FeedClient initialFeed={serverPage} initialChipId="for-you" />);

        expect(screen.getByText('card:post-1')).toBeTruthy();
        expect(screen.queryByText('card:old-1')).toBeNull();
    });

    it('keeps the home feed and the showcase grid in separate cache slots', () => {
        // Their filter tuples overlap, so only `surface` stops one restoring into
        // the other.
        const showcaseKey = buildShowcaseClientCacheKey({
            viewerId: null,
            category: 'all',
            sort: 'for-you',
            tool: null,
            unlock: 'all',
            resource: 'all',
        });

        expect(showcaseKey).not.toBe(homeFeedCacheKey());
    });
});
