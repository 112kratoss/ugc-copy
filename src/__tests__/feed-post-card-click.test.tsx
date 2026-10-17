import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedPostCard from '@/app/feed/FeedPostCard';
import {
    flushShowcaseFeedEvents,
    QualifiedImpressionBoundary,
    resetShowcaseFeedEventQueueForTests,
} from '@/app/showcase/ShowcaseFeedInteraction';
import { buildPostFeedCard } from '@/lib/post-feed-presentation';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseAssetSummary, ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

const postCommentsProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@/components/PostComments', () => ({
    default: (props: Record<string, unknown>) => {
        postCommentsProps.current = props;
        return <div data-testid="post-comments"><textarea aria-label="Write a comment" /></div>;
    },
}));

vi.mock('@/components/PublicShareButton', () => ({
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
        cardIndex: 0,
        onToggleExpanded: vi.fn(),
        onToggleComments: vi.fn(),
        onToggleSave: vi.fn(),
        onCommentCountChange: vi.fn(),
        onOpenMedia: vi.fn(),
        onOpenPost: vi.fn(),
        onRecordOpen: vi.fn(),
        onPrefetchPost: vi.fn(),
        onFeedback: vi.fn(),
        onRemix: vi.fn(),
        onReportContent: vi.fn(),
        onReportUser: vi.fn(),
        onBlockUser: vi.fn(),
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

    it('prioritizes the first above-the-fold media cover when requested', () => {
        renderCard({}, { priorityMedia: true });

        const image = screen.getByRole('img', { name: 'A launch frame' });
        expect(image).toHaveAttribute('loading', 'eager');
        expect(image).toHaveAttribute('fetchpriority', 'high');
    });

    it('opens the post when the card itself is clicked', () => {
        const { onOpenPost, onOpenMedia, onRecordOpen } = renderCard();

        fireEvent.click(cardSurface());

        expect(onOpenPost).toHaveBeenCalledTimes(1);
        expect(onOpenMedia).not.toHaveBeenCalled();
        // `onOpenPost` tells the ranker itself; once is enough.
        expect(onRecordOpen).not.toHaveBeenCalled();
    });

    it('leaves the title to its own link so there is exactly one permalink', () => {
        const { onOpenPost, onRecordOpen } = renderCard();
        const title = screen.getByRole('link', { name: 'A launch frame' });

        expect(title).toHaveAttribute(
            'href',
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT)
        );

        fireEvent.click(title);

        // The <Link> navigates; the card handler must not fire a second time,
        // and the ranker still hears that the post was opened.
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRecordOpen).toHaveBeenCalledTimes(1);
        expect(onRecordOpen).toHaveBeenCalledWith('post-1');
    });

    it('counts a title opened in a new tab, but not one downloaded with alt', () => {
        const { onRecordOpen } = renderCard();
        const title = screen.getByRole('link', { name: 'A launch frame' });

        // The browser opens the tab itself: no window.open of the card's.
        middleClick(title);
        fireEvent.click(title, { metaKey: true });
        fireEvent.click(title, { altKey: true });

        expect(onRecordOpen).toHaveBeenCalledTimes(2);
        expect(window.open).not.toHaveBeenCalled();
    });

    it('opens the lightbox — not the post — when the media is clicked', () => {
        const { onOpenMedia, onOpenPost, onRecordOpen } = renderCard();

        fireEvent.click(screen.getByRole('button', { name: 'A launch frame' }));

        expect(onOpenMedia).toHaveBeenCalledWith('post-1', 0);
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRecordOpen).not.toHaveBeenCalled();
    });

    // The web card opens the rest of a post in place; the app's Read more opens
    // the post page. Either way the reader went into the post.
    it('counts Read more as an open, and Show less as nothing', () => {
        // A mixed post's own words, long enough to clamp.
        const long = { postFormat: 'mixed', body: 'A long note about the light in this frame. '.repeat(20) } as const;
        const { onRecordOpen, onToggleExpanded, onOpenPost } = renderCard(long);

        fireEvent.click(screen.getByRole('button', { name: 'Read more' }));

        expect(onRecordOpen).toHaveBeenCalledTimes(1);
        expect(onRecordOpen).toHaveBeenCalledWith('post-1');
        expect(onToggleExpanded).toHaveBeenCalledWith('post-1');
        expect(onOpenPost).not.toHaveBeenCalled();

        cleanup();
        const expanded = renderCard(long, { expanded: true });

        fireEvent.click(screen.getByRole('button', { name: 'Show less' }));

        expect(expanded.onToggleExpanded).toHaveBeenCalledWith('post-1');
        expect(expanded.onRecordOpen).not.toHaveBeenCalled();
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

    it('starts the remix from the pill instead of opening the post', () => {
        const { onOpenPost, onRemix } = renderCard();

        fireEvent.click(screen.getByRole('button', { name: /Remix/i }));

        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRemix).toHaveBeenCalledTimes(1);
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
        const { onOpenPost, onRecordOpen } = renderCard();

        fireEvent.click(cardSurface(), { metaKey: true });

        expect(window.open).toHaveBeenCalledWith(
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT),
            '_blank',
            'noopener,noreferrer'
        );
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRecordOpen).toHaveBeenCalledWith('post-1');
    });

    it('opens a new tab on middle click', () => {
        const { onOpenPost, onRecordOpen } = renderCard();

        middleClick(cardSurface());

        expect(window.open).toHaveBeenCalledWith(
            buildShowcaseDetailPath('post-1', DETAIL_CONTEXT),
            '_blank',
            'noopener,noreferrer'
        );
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRecordOpen).toHaveBeenCalledWith('post-1');
    });

    it('ignores a middle click that lands on a control', () => {
        const { onRecordOpen } = renderCard();

        middleClick(screen.getByRole('link', { name: /Batman/i }));

        expect(window.open).not.toHaveBeenCalled();
        expect(onRecordOpen).not.toHaveBeenCalled();
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

// The rows the app's card menu and the reel's leave out on your own post
// (`ugc-mobile/lib/feed-feedback-menu.ts`, `getViewerSafetyActions`) follow
// this card: there is no one to hide, report or block, and a report on your
// own post asks for a review of your own work.
describe("FeedPostCard's menu, by whose post it is", () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function menuRows() {
        fireEvent.click(screen.getByRole('button', { name: /more actions for a launch frame/i }));
        return screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
    }

    it("offers every row on someone else's post", () => {
        renderCard({}, { viewerIsOwner: false });

        expect(menuRows()).toEqual(['Not interested', 'Hide @batman', 'Report content', 'Report user', 'Block user']);
    });

    it('offers Not interested and nothing else on your own', () => {
        renderCard({}, { viewerIsOwner: true });

        expect(menuRows()).toEqual(['Not interested']);
    });

    it("keeps Report content on a post with no creator account, which is no one's own", () => {
        renderCard({ creator: { id: null, username: null, name: 'Magicbooklet', avatar: null } });

        expect(menuRows()).toEqual(['Not interested', 'Report content']);
    });
});

// The recipe behind a post was a full-width bar under the media that named the
// recipe by its title, which is the post's title again. It is a chip at the end
// of the action row now, and only where it says something the row does not
// (`getPostFeedRecipeChip`; the cases are `contracts/feed-recipe-chip-v1.json`).
describe("FeedPostCard's recipe chip", () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function recipe(overrides: Partial<ShowcaseAssetSummary> = {}): ShowcaseAssetSummary {
        return {
            id: 'bundle-1',
            postId: 'post-1',
            title: 'A launch frame',
            accessMode: 'free',
            priceUsdCents: 0,
            previewText: '',
            allowRemix: false,
            ...overrides,
        } as ShowcaseAssetSummary;
    }

    const recipeHref = buildShowcaseDetailPath('post-1', { ...DETAIL_CONTEXT, section: 'resources' });
    const actionRow = () => screen.getByRole('button', { name: /Save A launch frame/i }).parentElement;

    it('draws nothing for a free recipe beside Remix', () => {
        renderCard({ asset: recipe(), canRemix: true });

        expect(screen.getByRole('button', { name: /Remix/ })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /recipe/i })).not.toBeInTheDocument();
        expect(document.querySelector(`a[href="${recipeHref}"]`)).toBeNull();
    });

    it('names a free recipe at the end of the action row on a card with no Remix', () => {
        renderCard({ asset: recipe(), canRemix: false });

        const chip = screen.getByRole('link', { name: 'Free recipe: A launch frame' });

        expect(screen.queryByRole('button', { name: /Remix/ })).not.toBeInTheDocument();
        expect(chip).toHaveAttribute('href', recipeHref);
        // The words, and not the post's title after them as the bar had it.
        expect(chip.textContent).toBe('Free recipe');
        expect(actionRow()?.lastElementChild).toBe(chip);
    });

    // In credits, as the app's chip reads: the chip said "$2.50" here.
    it("shows a paid recipe's price, beside Remix too", () => {
        renderCard({ asset: recipe({ accessMode: 'paid', priceUsdCents: 250 }), canRemix: true });

        const chip = screen.getByRole('link', { name: '250 credits: A launch frame' });

        expect(screen.getByRole('button', { name: /Remix/ })).toBeInTheDocument();
        expect(chip).toHaveAttribute('href', recipeHref);
        expect(chip.textContent).toBe('250 credits');
        expect(actionRow()?.lastElementChild).toBe(chip);
    });

    // Only credits buy a recipe under the cash minimum, so the card names no
    // cash price for it ("$0.50 recipe" before).
    it('prices a credits-only recipe in credits', () => {
        renderCard({ asset: recipe({ accessMode: 'paid', priceUsdCents: 50 }), canRemix: true });

        const chip = screen.getByRole('link', { name: '50 credits: A launch frame' });

        expect(chip.textContent).toBe('50 credits');
        expect(document.body.textContent).not.toContain('$0.50');
    });

    it('draws nothing on a post with no recipe', () => {
        renderCard({ asset: null, canRemix: false });

        expect(screen.queryByRole('link', { name: /recipe/i })).not.toBeInTheDocument();
    });

    it('keeps its click to itself: the card does not open the post as well', () => {
        const { onOpenPost } = renderCard({ asset: recipe(), canRemix: false });

        fireEvent.click(screen.getByRole('link', { name: 'Free recipe: A launch frame' }));

        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('tells the feed the card’s resources were opened', () => {
        const onOpenResources = vi.fn();
        const { onRecordOpen } = renderCard({ asset: recipe({ accessMode: 'paid', priceUsdCents: 250 }), canRemix: true }, { onOpenResources });

        fireEvent.click(screen.getByRole('link', { name: '250 credits: A launch frame' }));

        expect(onOpenResources).toHaveBeenCalledWith('post-1');
        // The chip is heard as `resource_open` alone, on both clients: not an open.
        expect(onRecordOpen).not.toHaveBeenCalled();
    });
});

// The card drew Remix only when `canRemix`, which the server sets false where
// the creator sells the remix with the recipe; the app and the web reel draw
// it in all three cases (01-4).
describe("FeedPostCard's Remix behind a recipe", () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function lockedBehind(overrides: Partial<ShowcaseAssetSummary>): Partial<ShowcaseFeedItem> {
        return {
            canRemix: false,
            remixCapability: 'unlock_required',
            remixTarget: 'image',
            asset: {
                id: 'bundle-1',
                postId: 'post-1',
                title: 'A launch frame',
                accessMode: 'free',
                priceUsdCents: 0,
                previewText: '',
                allowRemix: true,
                ...overrides,
            } as ShowcaseAssetSummary,
        };
    }

    const recipeHref = buildShowcaseDetailPath('post-1', { ...DETAIL_CONTEXT, section: 'resources' });

    it('starts a remix that sits behind a free unlock from Remix, with no chip beside it', () => {
        const onOpenResources = vi.fn();
        const { onRemix, onOpenPost } = renderCard(lockedBehind({}), { onOpenResources });

        fireEvent.click(screen.getByRole('button', { name: 'Remix · 1' }));

        // The feed takes the free recipe on the way (FeedClient's handler).
        expect(onRemix).toHaveBeenCalledWith('post-1');
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(screen.queryByText('Free recipe')).not.toBeInTheDocument();
        expect(document.querySelector(`a[href="${recipeHref}"]`)).toBeNull();
    });

    it('sells a remix behind a paid unlock on the recipe, with the price drawn once', () => {
        const onOpenResources = vi.fn();
        const { onRemix, onOpenPost, onRecordOpen } = renderCard(
            lockedBehind({ accessMode: 'paid', priceUsdCents: 250 }),
            { onOpenResources },
        );

        const remix = screen.getByRole('link', { name: 'Unlock A launch frame to remix it, 250 credits' });

        expect(remix).toHaveAttribute('href', recipeHref);
        expect(remix.textContent).toBe('250 credits');
        // No second pill with the same price at the end of the row.
        expect(screen.getAllByText('250 credits')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: /Remix/ })).not.toBeInTheDocument();

        fireEvent.click(remix);

        expect(onOpenResources).toHaveBeenCalledWith('post-1');
        expect(onRemix).not.toHaveBeenCalled();
        expect(onOpenPost).not.toHaveBeenCalled();
        expect(onRecordOpen).not.toHaveBeenCalled();
    });

    it('draws no Remix where the unlock would not include one', () => {
        renderCard({ ...lockedBehind({ accessMode: 'paid', priceUsdCents: 250, allowRemix: false }) });

        expect(screen.queryByRole('button', { name: /Remix/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /to remix it/ })).not.toBeInTheDocument();
        // The recipe is still for sale, on its chip.
        expect(screen.getByRole('link', { name: '250 credits: A launch frame' })).toHaveAttribute('href', recipeHref);
    });
});

// Feed ranking v4, §4: what a Home card reports past its impression.
describe("FeedPostCard's feed telemetry", () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
        postCommentsProps.current = null;
        resetShowcaseFeedEventQueueForTests();
    });

    afterEach(() => {
        cleanup();
        resetShowcaseFeedEventQueueForTests();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const ranked = { recommendation: { deliveryId: '9001', position: 4, reason: 'Popular with creators like you', algorithmVersion: 'for-you-rules:4' } };

    it("credits a comment written under a ranked card to the card's delivery", () => {
        renderCard(ranked, { commentsOpen: true });

        expect(postCommentsProps.current).toMatchObject({ postId: 'post-1', deliveryId: '9001' });
    });

    // The post page reads `?delivery=` and credits a report or a comment
    // filed there to the card that showed the post (C2).
    it("carries a ranked card's delivery into the post page from its links", () => {
        const recipe = {
            id: 'bundle-1',
            postId: 'post-1',
            title: 'A launch frame',
            accessMode: 'paid',
            priceUsdCents: 250,
            previewText: '',
            allowRemix: false,
        } as ShowcaseAssetSummary;
        vi.stubGlobal('open', vi.fn());
        renderCard({ ...ranked, asset: recipe });

        const title = screen.getByRole('link', { name: 'A launch frame' });
        const chip = screen.getByRole('link', { name: '250 credits: A launch frame' });

        expect(title).toHaveAttribute('href', buildShowcaseDetailPath('post-1', { ...DETAIL_CONTEXT, deliveryId: '9001' }));
        expect(title.getAttribute('href')).toContain('delivery=9001');
        expect(chip).toHaveAttribute(
            'href',
            buildShowcaseDetailPath('post-1', { ...DETAIL_CONTEXT, section: 'resources', deliveryId: '9001' }),
        );

        // A new tab opens the same address.
        fireEvent.click(screen.getByText(/Image/i, { selector: 'p' }), { metaKey: true });
        expect(window.open).toHaveBeenCalledWith(title.getAttribute('href'), '_blank', 'noopener,noreferrer');
    });

    it('sends no delivery with a comment under an unranked card', () => {
        renderCard({}, { commentsOpen: true });

        expect(postCommentsProps.current).toMatchObject({ postId: 'post-1', deliveryId: null });
    });

    function renderInBoundary(media: Partial<ShowcaseMediaItem>) {
        const card = buildPostFeedCard(feedItem({
            ...ranked,
            category: 'video',
            mediaKind: 'video',
            mediaItems: [mediaItem({ mediaKind: 'video', contentType: 'video/mp4', ...media })],
        }));
        const noop = vi.fn();
        return render(
            <QualifiedImpressionBoundary item={card.item} feedSessionId={null} accessToken={null} position={0} sourceSurface="feed" trackAttention>
                <FeedPostCard
                    card={card}
                    isSaved={false}
                    saving={false}
                    expanded={false}
                    commentsOpen={false}
                    accessToken={null}
                    cardIndex={0}
                    onToggleExpanded={noop}
                    onToggleComments={noop}
                    onToggleSave={noop}
                    onCommentCountChange={noop}
                    onOpenMedia={noop}
                    onOpenPost={noop}
                    onRecordOpen={noop}
                    onPrefetchPost={noop}
                    onFeedback={noop}
                    onRemix={noop}
                    onReportContent={noop}
                    onReportUser={noop}
                    onBlockUser={noop}
                />
            </QualifiedImpressionBoundary>
        );
    }

    function playTo(video: HTMLVideoElement, currentTime: number, duration: number) {
        Object.defineProperty(video, 'currentTime', { configurable: true, value: currentTime });
        Object.defineProperty(video, 'duration', { configurable: true, value: duration });
        fireEvent.timeUpdate(video);
    }

    function sentEvents(fetchMock: ReturnType<typeof vi.fn>) {
        return fetchMock.mock.calls.flatMap(([, init]) => (
            JSON.parse(String((init as RequestInit).body)) as { events: Array<Record<string, unknown>> }
        ).events);
    }

    it('reports how far its inline video played, at each milestone and as it goes', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true })));
        vi.stubGlobal('fetch', fetchMock);
        const { container, unmount } = renderInBoundary({ url: 'https://cdn.example.test/clip.mp4', feedStreamUrl: 'https://cdn.example.test/clip.feed.mp4', durationSeconds: 12 });
        const video = container.querySelector('video') as HTMLVideoElement;

        playTo(video, 1, 12);
        playTo(video, 3.6, 12);
        await act(async () => {
            await flushShowcaseFeedEvents();
        });
        expect(sentEvents(fetchMock)).toEqual([expect.objectContaining({
            eventType: 'media_progress',
            progress: 0.3,
            durationMs: 12_000,
            deliveryId: '9001',
            sourceSurface: 'feed',
        })]);

        playTo(video, 4.2, 12);
        unmount();
        await act(async () => {
            await flushShowcaseFeedEvents();
        });
        // The rest of the way it got, sent as the card goes.
        expect(sentEvents(fetchMock).at(-1)).toMatchObject({ eventType: 'media_progress', progress: 4.2 / 12, durationMs: 12_000 });
    });

    it("measures a teaser's play against the whole clip it opens", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true })));
        vi.stubGlobal('fetch', fetchMock);
        const teaser = 'https://cdn.example.test/clip.teaser.mp4';
        const { container, unmount } = renderInBoundary({ url: 'https://cdn.example.test/clip.mp4', teaserUrl: teaser, feedStreamUrl: teaser, durationSeconds: 95.5 });

        // The whole eight-second teaser, looped: not the clip watched to its end.
        playTo(container.querySelector('video') as HTMLVideoElement, 7.9, 8);
        unmount();
        await act(async () => {
            await flushShowcaseFeedEvents();
        });

        expect(sentEvents(fetchMock)).toEqual([expect.objectContaining({
            eventType: 'media_progress',
            progress: 7.9 / 95.5,
            durationMs: 95_500,
        })]);
    });
});
