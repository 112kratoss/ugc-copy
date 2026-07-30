import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedPostCard from '@/app/feed/FeedPostCard';
import { buildPostFeedCard } from '@/lib/post-feed-presentation';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

vi.mock('@/app/components/PostComments', () => ({
    default: () => <div data-testid="post-comments"><textarea aria-label="Write a comment" /></div>,
}));

vi.mock('@/app/components/PublicShareButton', () => ({
    default: ({ className }: { className?: string }) => (
        <button type="button" aria-label="Share" className={className} />
    ),
}));

class IntersectionObserverMock {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    disconnect = vi.fn();
    observe = vi.fn();
    takeRecords = vi.fn(() => []);
    unobserve = vi.fn();
}

function mediaItem(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
    return {
        id: 'media-1',
        url: 'https://cdn.example.test/post-1.png',
        previewUrl: 'https://cdn.example.test/post-1.preview.webp',
        mediaKind: 'image',
        contentType: 'image/png',
        originalName: 'post-1.png',
        width: 1080,
        height: 1350,
        sortOrder: 0,
        ...overrides,
    } as ShowcaseMediaItem;
}

function feedItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
    return {
        id: 'post-1',
        mediaUrl: 'https://cdn.example.test/post-1.png',
        mediaKind: 'image',
        mediaItems: [mediaItem()],
        model: 'Nano Banana',
        title: 'A launch frame',
        prompt: 'a cinematic product frame',
        body: 'A long body that a reader might want to select rather than click through.',
        category: 'image',
        postFormat: 'media',
        saveCount: 3,
        remixCount: 1,
        commentCount: 2,
        createdAt: '2026-07-28T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'batman', name: 'Batman', avatar: null },
        sourceKind: 'magicbooklet',
        sourceTool: null,
        generationId: 'gen-1',
        asset: null,
        canRemix: true,
        ...overrides,
    } as ShowcaseFeedItem;
}

const DETAIL_CONTEXT = { from: 'community', returnTo: '/feed' };

function renderCard(overrides: Partial<ShowcaseFeedItem> = {}, props: Record<string, unknown> = {}) {
    const handlers = {
        onToggleExpanded: vi.fn(),
        onToggleComments: vi.fn(),
        onToggleSave: vi.fn(),
        onCommentCountChange: vi.fn(),
        onOpenMedia: vi.fn(),
        onOpenPost: vi.fn(),
        onPrefetchPost: vi.fn(),
    };
    const card = buildPostFeedCard(feedItem(overrides));
    render(
        <FeedPostCard
            card={card}
            isSaved={false}
            saving={false}
            expanded={false}
            commentsOpen={false}
            accessToken={null}
            detailContext={DETAIL_CONTEXT}
            {...handlers}
            {...props}
        />
    );
    return { ...handlers, card };
}

/** The card's own surface: the metadata line under the title. */
function cardSurface() {
    return screen.getByText(/Image/i, { selector: 'p' });
}

/** `fireEvent.auxClick` is not exposed by this testing-library version. */
function middleClick(element: Element) {
    fireEvent(element, new MouseEvent('auxclick', {
        button: 1,
        bubbles: true,
        cancelable: true,
    }));
}

describe('FeedPostCard click routing', () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
        vi.stubGlobal('open', vi.fn());
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('opens the post when the card itself is clicked', () => {
        const { onOpenPost, onOpenMedia } = renderCard();

        fireEvent.click(cardSurface());

        expect(onOpenPost).toHaveBeenCalledTimes(1);
        expect(onOpenMedia).not.toHaveBeenCalled();
    });

    it('leaves the title to its own link so there is exactly one permalink', () => {
        const { onOpenPost } = renderCard();
        const title = screen.getByRole('link', { name: 'A launch frame' });

        expect(title).toHaveAttribute(
            'href',
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT)
        );

        fireEvent.click(title);

        // The <Link> navigates; the card handler must not fire a second time.
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('opens the lightbox — not the post — when the media is clicked', () => {
        const { onOpenMedia, onOpenPost } = renderCard();

        fireEvent.click(screen.getByRole('button', { name: 'A launch frame' }));

        expect(onOpenMedia).toHaveBeenCalledWith(0);
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it.each([
        ['Save', /Save A launch frame/i],
        ['Comment', /Show comments on A launch frame/i],
        ['Share', /^Share$/],
    ])('leaves the %s control to its own handler', (_label, name) => {
        const { onOpenPost } = renderCard();

        fireEvent.click(screen.getByRole('button', { name }));

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('leaves the creator link alone', () => {
        const { onOpenPost } = renderCard();

        fireEvent.click(screen.getByRole('link', { name: /Batman/i }));

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('leaves the remix pill alone', () => {
        const { onOpenPost } = renderCard();

        fireEvent.click(screen.getByRole('link', { name: /Remix/i }));

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('does not navigate from inside the expanded comments', () => {
        const { onOpenPost, onOpenMedia } = renderCard({}, { commentsOpen: true });

        const comments = screen.getByTestId('post-comments');
        fireEvent.click(comments);
        fireEvent.click(within(comments).getByLabelText('Write a comment'));

        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onOpenMedia).not.toHaveBeenCalled();
    });

    it('does not navigate when the click ends a text selection', () => {
        const { onOpenPost } = renderCard();
        vi.spyOn(window, 'getSelection').mockReturnValue({
            isCollapsed: false,
        } as unknown as Selection);

        fireEvent.click(cardSurface());

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('does not navigate on a double click, which is selecting a word', () => {
        const { onOpenPost } = renderCard();

        fireEvent.click(cardSurface(), { detail: 2 });

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('opens a new tab on cmd-click instead of navigating in place', () => {
        const { onOpenPost } = renderCard();

        fireEvent.click(cardSurface(), { metaKey: true });

        expect(window.open).toHaveBeenCalledWith(
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT),
            '_blank',
            'noopener,noreferrer'
        );
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('opens a new tab on middle click', () => {
        const { onOpenPost } = renderCard();

        middleClick(cardSurface());

        expect(window.open).toHaveBeenCalledWith(
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT),
            '_blank',
            'noopener,noreferrer'
        );
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('ignores a middle click that lands on a control', () => {
        renderCard();

        middleClick(screen.getByRole('link', { name: /Batman/i }));

        expect(window.open).not.toHaveBeenCalled();
    });

    it('warms the post on pointer intent, before any click', () => {
        const { onPrefetchPost, onOpenPost } = renderCard();

        fireEvent.pointerEnter(cardSurface());

        expect(onPrefetchPost).toHaveBeenCalled();
        // Warming must never be mistaken for opening.
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('warms the post for keyboard users too', () => {
        const { onPrefetchPost } = renderCard();

        fireEvent.focus(screen.getByRole('link', { name: 'A launch frame' }));

        expect(onPrefetchPost).toHaveBeenCalled();
    });

    it('does not warm anything on plain render', () => {
        const { onPrefetchPost } = renderCard();

        expect(onPrefetchPost).not.toHaveBeenCalled();
    });

    it('still opens the post from a text-only card that has no media', () => {
        const { onOpenPost, onOpenMedia } = renderCard({
            mediaUrl: null,
            mediaKind: null,
            mediaItems: [],
            category: 'text',
            postFormat: 'text',
            prompt: '',
            title: 'Just a note',
            body: 'Some thoughts with no attachment.',
        });

        fireEvent.click(screen.getByText('Some thoughts with no attachment.'));

        expect(onOpenPost).toHaveBeenCalledTimes(1);
        expect(onOpenMedia).not.toHaveBeenCalled();
    });
});
