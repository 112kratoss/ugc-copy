import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

const routerPush = vi.fn();
const routerPrefetch = vi.fn();
const publishNavigationStartMock = vi.fn();

vi.mock('@/app/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: routerPush, prefetch: routerPrefetch }),
}));

vi.mock('@/app/components/navigation-progress-state', () => ({
    publishNavigationStart: () => publishNavigationStartMock(),
}));

// Expose the two navigation props as buttons so the test drives the real
// FeedClient wiring without depending on the card's internal click guards.
vi.mock('@/app/feed/FeedPostCard', () => ({
    default: ({ card, onOpenPost, onPrefetchPost }: {
        card: { id: string; title: string };
        onOpenPost: () => void;
        onPrefetchPost: () => void;
    }) => (
        <article>
            <button type="button" onClick={onOpenPost}>{`open:${card.id}`}</button>
            <button type="button" onClick={onPrefetchPost}>{`warm:${card.id}`}</button>
        </article>
    ),
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
        creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
        isSaved: false,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    } as ShowcaseFeedItem;
}

const feed: ShowcaseFeedPage = {
    items: [item('post-1', 'First'), item('post-2', 'Second')],
    pageInfo: { hasMore: false, nextOffset: null },
} as ShowcaseFeedPage;

function renderFeed() {
    render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
}

describe('FeedClient navigation', () => {
    beforeEach(() => {
        routerPush.mockClear();
        routerPrefetch.mockClear();
        publishNavigationStartMock.mockClear();
    });

    afterEach(() => {
        cleanup();
    });

    it('warms a post the first time intent is shown', () => {
        renderFeed();

        fireEvent.click(screen.getByText('warm:post-1'));

        expect(routerPrefetch).toHaveBeenCalledWith('/showcase/post-1?from=community&returnTo=%2Ffeed');
    });

    it('warms each post only once, however many times it is hovered', () => {
        renderFeed();

        fireEvent.click(screen.getByText('warm:post-1'));
        fireEvent.click(screen.getByText('warm:post-1'));
        fireEvent.click(screen.getByText('warm:post-1'));

        expect(routerPrefetch).toHaveBeenCalledTimes(1);
    });

    it('warms distinct posts independently', () => {
        renderFeed();

        fireEvent.click(screen.getByText('warm:post-1'));
        fireEvent.click(screen.getByText('warm:post-2'));

        expect(routerPrefetch).toHaveBeenCalledTimes(2);
    });

    it('announces the navigation before pushing, so the bar can appear', () => {
        renderFeed();

        fireEvent.click(screen.getByText('open:post-1'));

        // An imperative push raises no link status of its own; without this the
        // click would go unacknowledged for the length of the round trip.
        expect(publishNavigationStartMock).toHaveBeenCalledTimes(1);
        expect(routerPush).toHaveBeenCalledWith('/showcase/post-1?from=community&returnTo=%2Ffeed');
    });

    it('does not warm or navigate on plain render', () => {
        renderFeed();

        expect(routerPrefetch).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        expect(publishNavigationStartMock).not.toHaveBeenCalled();
    });
});
