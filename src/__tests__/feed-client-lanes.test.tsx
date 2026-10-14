import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient, { forgetFeedRemovalsForTests } from '@/app/feed/FeedClient';
import { FEED_REMOVAL_UNDO_MS } from '@/app/showcase/ShowcaseFeedInteraction';
import { NEW_POSTS_PROBE_AFTER_MS } from '@/lib/feed-newest-probe';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';
import { REMIX_UNLOCK_REQUIRED_CODE as SERVER_REMIX_UNLOCK_REQUIRED_CODE } from '@/lib/remix-access';
import {
    buildShowcaseClientCacheKey,
    clearShowcaseClientCacheForTests,
    writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import { REMIX_UNLOCK_REQUIRED_CODE, ShowcaseRemixRequestError } from '@/lib/showcase-remix-client';

// One router for every render: a new object per render would hand the feed
// new callbacks each time.
const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
const routerPush = router.push;
const auth = vi.hoisted(() => ({
    state: { session: null, user: null } as {
        session: { access_token: string } | null;
        user: { id: string } | null;
        isLoading?: boolean;
    },
}));
// Renders of each card, by post id.
const cardRenders = vi.hoisted(() => new Map<string, number>());
const sendEventMock = vi.hoisted(() => vi.fn(async () => undefined));
const resourceOpenMock = vi.hoisted(() => vi.fn());
const requestRemixMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn<(request: { title: string; tone?: string }) => Promise<boolean>>(async () => true));

vi.mock('@/components/feedback-state', () => ({
    requestConfirmation: confirmMock,
}));

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => auth.state,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => router,
}));

vi.mock('@/components/navigation-progress-state', () => ({
    publishNavigationStart: () => undefined,
}));

vi.mock('@/app/showcase/ShowcaseFeedInteraction', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/app/showcase/ShowcaseFeedInteraction')>()),
    sendShowcaseFeedEvent: sendEventMock,
    sendShowcaseResourceOpenEvent: resourceOpenMock,
}));

vi.mock('@/lib/showcase-remix-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/showcase-remix-client')>()),
    requestShowcaseRemix: requestRemixMock,
}));

// The card's menu and pill as plain buttons, so the test drives FeedClient's
// own handlers rather than the menu's keyboard and portal plumbing. Memoised
// as the real card is, so a render counted here is one the feed's props asked
// for.
vi.mock('@/app/feed/FeedPostCard', async () => {
    const { memo } = await import('react');
    return {
        default: memo(function SpyFeedPostCard({ card, isSaved, remixing, onFeedback, onRemix, onReportContent, onReportUser, onBlockUser, onToggleSave, onOpenResources, onOpenPost, onRecordOpen, onPrefetchPost }: {
            card: { id: string; title: string; item: ShowcaseFeedItem };
            isSaved: boolean;
            remixing: boolean;
            onFeedback: (postId: string, action: 'not_interested' | 'hide_creator') => void;
            onRemix: (postId: string) => void;
            onReportContent: (postId: string) => void;
            onReportUser: (postId: string) => void;
            onBlockUser: (postId: string) => void;
            onToggleSave: (postId: string) => void;
            onOpenResources?: (postId: string) => void;
            onOpenPost: (postId: string) => void;
            onRecordOpen: (postId: string) => void;
            onPrefetchPost: (postId: string) => void;
        }) {
            cardRenders.set(card.id, (cardRenders.get(card.id) ?? 0) + 1);
            return (
                <article data-delivery={card.item.recommendation?.deliveryId ?? ''}>
                    <h3>{card.title}</h3>
                    <button type="button" aria-pressed={isSaved} onClick={() => onToggleSave(card.id)}>{`save:${card.id}`}</button>
                    <button type="button" onClick={() => onOpenPost(card.id)}>{`open:${card.id}`}</button>
                    <button type="button" onClick={() => onPrefetchPost(card.id)}>{`warm:${card.id}`}</button>
                    <button type="button" onClick={() => onRecordOpen(card.id)}>{`opened-by-link:${card.id}`}</button>
                    <button type="button" onClick={() => onOpenResources?.(card.id)}>{`recipe:${card.id}`}</button>
                    <button type="button" onClick={() => onFeedback(card.id, 'not_interested')}>{`not-interested:${card.id}`}</button>
                    <button type="button" onClick={() => onFeedback(card.id, 'hide_creator')}>{`hide:${card.id}`}</button>
                    <button type="button" disabled={remixing} onClick={() => onRemix(card.id)}>{`remix:${card.id}`}</button>
                    <button type="button" onClick={() => onReportContent(card.id)}>{`report-content:${card.id}`}</button>
                    <button type="button" onClick={() => onReportUser(card.id)}>{`report-user:${card.id}`}</button>
                    <button type="button" onClick={() => onBlockUser(card.id)}>{`block:${card.id}`}</button>
                </article>
            );
        }),
    };
});

function item(id: string, title: string, creatorId = 'creator-1'): ShowcaseFeedItem {
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
        creator: { id: creatorId, username: creatorId, name: `Creator ${creatorId}`, avatar: null },
        isSaved: false,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: true,
    } as ShowcaseFeedItem;
}

function page(items: ShowcaseFeedItem[]): ShowcaseFeedPage {
    return { items, pageInfo: { hasMore: false, nextOffset: null } } as ShowcaseFeedPage;
}

const feed = page([item('post-1', 'First'), item('post-2', 'Second', 'creator-2'), item('post-3', 'Third')]);

/** A card the ranker served: it names its delivery. */
function ranked(post: ShowcaseFeedItem, deliveryId: string): ShowcaseFeedItem {
    return {
        ...post,
        recommendation: { deliveryId, position: 0, reason: 'Popular with creators like you', algorithmVersion: 'for-you-rules-v4' },
    } as ShowcaseFeedItem;
}

// A ranked page names the session that ranked it.
const rankedFeed = {
    ...page([
        ranked(item('post-1', 'First'), '901'),
        ranked(item('post-2', 'Second', 'creator-2'), '902'),
        ranked(item('post-3', 'Third'), '903'),
    ]),
    feedSessionId: 'ranked-session',
} as ShowcaseFeedPage;

const HOME_DETAIL_CONTEXT = { from: 'home', returnTo: '/' };

function homeFeedSnapshotKey(category: 'all' | 'text', viewerId: string | null = null) {
    return buildShowcaseClientCacheKey({
        surface: 'home-feed',
        viewerId,
        category,
        sort: 'for-you',
        tool: null,
        unlock: 'all',
        resource: 'all',
    });
}

/** Answers each request by its address: `respond` returns the JSON body. */
function mockRoutedFetch(respond: (url: string) => unknown) {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
        async (url) => ({ ok: true, status: 200, json: async () => respond(url) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const savePressed = (postId: string) => screen.getByText(`save:${postId}`).getAttribute('aria-pressed');

function mockJsonFetch(body: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
        async () => ({ ok, status, json: async () => body }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function mockFetchPage(items: ShowcaseFeedItem[]) {
    const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; json: () => Promise<ShowcaseFeedPage> }>>(
        async () => ({ ok: true, json: async () => page(items) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** Requests that never answer: a guest's own page one still on its way. */
function holdRequests() {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<never>>(() => new Promise<never>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** The guest's own page one: For you, from the top (Notes and Unlocks rank too). */
const isForYouPageOne = (url: string) => url.startsWith('/api/showcase/feed?')
    && url.includes('sort=for-you')
    && url.includes('offset=0')
    && !url.includes('category=')
    && !url.includes('unlock=');

/** The sentinel's observer, fired by hand: jsdom has none. */
function stubSentinel() {
    const sentinel = { intersect: () => undefined as void };
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            // Each card watches itself for its impression too; only the
            // sentinel, 600 px ahead, loads pages.
            if (options?.rootMargin !== '600px 0px') return;
            sentinel.intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
    });
    return sentinel;
}

describe('FeedClient lanes and card actions', () => {
    beforeEach(() => {
        routerPush.mockClear();
        router.prefetch.mockClear();
        cardRenders.clear();
        // Nothing reaches a network: a case that answers requests stubs its own.
        holdRequests();
        sendEventMock.mockClear();
        resourceOpenMock.mockClear();
        requestRemixMock.mockReset();
        confirmMock.mockReset();
        confirmMock.mockResolvedValue(true);
        auth.state = { session: null, user: null };
        window.history.replaceState(null, '', '/');
        // Each case is a fresh visit: the lane snapshot one case leaves behind
        // would otherwise be restored by the next, which is right in the
        // browser and wrong here. The same goes for what a case removed.
        clearShowcaseClientCacheForTests();
        forgetFeedRemovalsForTests();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('removes a post the viewer is not interested in and tells the ranker on the feed surface', async () => {
        // Signed out, on a card the ranker delivered: sent as before.
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-1'));

        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'not_interested',
            sourceSurface: 'feed',
            item: expect.objectContaining({ id: 'post-1' }),
        }));
        expect(await screen.findByText('Post removed for this visit.')).toBeInTheDocument();
    });

    it('hides every post by a creator at once', async () => {
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('hide:post-1'));

        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(screen.queryByText('Third')).not.toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hide_creator' }));
        expect(await screen.findByText('Posts from Creator creator-1 are hidden for this visit.')).toBeInTheDocument();
    });

    it('puts the post back when the preference cannot be saved', async () => {
        sendEventMock.mockRejectedValueOnce(new Error('offline'));
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-2'));

        expect(await screen.findByText(/post was restored/)).toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
    });

    // The server refuses a signed-out viewer's feedback on a card it never
    // delivered (page one of the static `/`, Recent), and the row used to fail
    // every time with "the post was restored".
    it('keeps a signed-out removal from a card with no delivery to this visit, and sends nothing', async () => {
        // The guest's own page one, which brings the deliveries, has not landed.
        const fetchMock = holdRequests();
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-1'));

        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(await screen.findByText('Post removed for this visit.')).toBeInTheDocument();

        fireEvent.click(screen.getByText('hide:post-2'));

        expect(screen.queryByText('Second')).not.toBeInTheDocument();
        expect(await screen.findByText('Posts from Creator creator-2 are hidden for this visit.')).toBeInTheDocument();
        expect(screen.getByText('Third')).toBeInTheDocument();
        expect(sendEventMock).not.toHaveBeenCalled();
        // Nothing but that page one was asked for.
        expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => !isForYouPageOne(url))).toEqual([]);
    });

    it('leaves a removed post out of later lanes and of the page one it comes back to, for that viewer only', async () => {
        mockFetchPage([item('post-1', 'First'), item('note-1', 'Note one')]);
        const { unmount } = render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-1'));
        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));

        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(screen.queryByText('First')).not.toBeInTheDocument();

        // Opening a post unmounts the feed; the server's page one still holds it.
        unmount();
        window.history.replaceState(null, '', '/');
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        expect(screen.getByText('Second')).toBeInTheDocument();
        expect(screen.queryByText('First')).not.toBeInTheDocument();

        cleanup();
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        expect(screen.getByText('First')).toBeInTheDocument();
    });

    it('writes the lane to the address and comes back to it from memory, without a refetch', async () => {
        const fetchMock = mockFetchPage([item('note-1', 'Note one')]);
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));

        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(window.location.search).toBe('?chip=notes');
        const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
        expect(requestedUrl).toContain('category=text');
        expect(requestedUrl).toContain('sort=for-you');

        fireEvent.click(screen.getByRole('button', { name: 'For you' }));

        expect(await screen.findByText('First')).toBeInTheDocument();
        expect(window.location.search).toBe('');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));

        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetches page one itself when the server render had none', async () => {
        const fetchMock = mockFetchPage([item('late-1', 'Late one')]);
        render(<FeedClient initialFeed={null} initialChipId="for-you" />);

        expect(await screen.findByText('Late one')).toBeInTheDocument();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('offset=0');
    });

    it('sends a signed-out remix to sign in, with the way back', () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('remix:post-1'));

        expect(requestRemixMock).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?returnUrl=/));
    });

    it('starts the remix from the card and goes straight to the creator', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        requestRemixMock.mockResolvedValue({ redirectTo: '/create-image?remix=post-1' });
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        expect(requestRemixMock).toHaveBeenCalledWith({ accessToken: 'token', postId: 'post-1' });
        await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/create-image?remix=post-1'));
        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'remix_start',
            sourceSurface: 'feed',
        }));
        // Nothing stood in the way, so nothing was unlocked.
        expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('unlock-free'))).toBe(false);
    });

    it('sends an unlock-gated remix to the post page, where the unlock is sold', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        requestRemixMock.mockRejectedValue(new ShowcaseRemixRequestError('Unlock needed', 403, 'REMIX_UNLOCK_REQUIRED'));
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/showcase/post-1?from=community&returnTo=%2Ffeed#recipe'));
        // The unlock the tap was sent to is the card's resources opening.
        expect(resourceOpenMock).toHaveBeenCalledWith(expect.objectContaining({
            item: expect.objectContaining({ id: 'post-1' }),
            sourceSurface: 'feed',
            accessToken: 'token',
            fallbackPosition: 0,
        }));
    });

    it('tells the ranker when the recipe chip opens a card’s resources', () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('recipe:post-2'));

        expect(resourceOpenMock).toHaveBeenCalledTimes(1);
        expect(resourceOpenMock).toHaveBeenCalledWith(expect.objectContaining({
            item: expect.objectContaining({ id: 'post-2' }),
            sourceSurface: 'feed',
            accessToken: 'token',
            fallbackPosition: 1,
        }));
    });

    // The Home feed's saves reached the ranker from Explore and the reel only.
    it('tells the ranker about a save, and its undoing, once the server has it', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockJsonFetch({ success: true, isSaved: true, saveCount: 1 });
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('save:post-3'));

        await waitFor(() => expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            item: expect.objectContaining({ id: 'post-3' }),
            eventType: 'save',
            sourceSurface: 'feed',
            accessToken: 'token',
            fallbackPosition: 2,
        })));
        expect(fetchMock).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({ method: 'POST' }));

        mockJsonFetch({ success: true, isSaved: false, saveCount: 0 });
        fireEvent.click(screen.getByText('save:post-3'));
        await waitFor(() => expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            item: expect.objectContaining({ id: 'post-3' }),
            eventType: 'unsave',
        })));
    });

    it('does not report a save the server refused', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        mockJsonFetch({ success: false, error: 'Nope' }, false, 500);
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('save:post-1'));

        expect(await screen.findByText('Could not update that save. Try again.')).toBeInTheDocument();
        expect(sendEventMock).not.toHaveBeenCalled();
        // In the notice, not the load alert: that alert's Retry loads a page,
        // and at the end of a lane reloads it from the top.
        expect(screen.getByRole('status')).toHaveTextContent('Could not update that save. Try again.');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
        expect(savePressed('post-1')).toBe('false');
    });

    it('shows a lane that failed to load as the error with its Retry, not as an empty lane', async () => {
        mockJsonFetch({ error: 'down' }, false, 503);
        render(<FeedClient initialFeed={null} initialChipId="for-you" />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this lane.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        expect(screen.queryByText('Nothing in this lane yet')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Share the first post' })).not.toBeInTheDocument();
    });

    it('invites the first post into a lane that loaded empty', () => {
        render(<FeedClient initialFeed={page([])} initialChipId="for-you" />);

        expect(screen.getByText('Nothing in this lane yet')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Share the first post' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    // A saved post showed an empty heart unless it was on the page the lane
    // mounted with, and its first tap "saved" it again.
    it('draws the saved heart of a post that arrives on page two', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const sentinel = { intersect: () => undefined as void };
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback: IntersectionObserverCallback) {
                sentinel.intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
            }
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() { return []; }
        });
        // One post: jsdom has no layout, so the windowed list mounts the
        // first four cards only.
        mockRoutedFetch((url) => (url.startsWith('/api/showcase/feed')
            ? page([{ ...item('post-4', 'Fourth'), isSaved: true }])
            : []));
        render(<FeedClient
            initialFeed={{ ...feed, pageInfo: { hasMore: true, nextOffset: 3 } } as ShowcaseFeedPage}
            initialChipId="for-you"
        />);

        act(() => sentinel.intersect());

        expect(await screen.findByText('Fourth')).toBeInTheDocument();
        expect(savePressed('post-4')).toBe('true');
        expect(savePressed('post-1')).toBe('false');
    });

    it('keeps the saved hearts of a lane it comes back to, and a save undone in between', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        mockRoutedFetch((url) => {
            if (url === '/api/showcase/save') return { success: true, isSaved: false, saveCount: 0 };
            if (url.startsWith('/api/showcase/feed')) {
                return page([{ ...item('note-1', 'Note one'), isSaved: true }, { ...item('post-1', 'First'), isSaved: true }]);
            }
            return [];
        });
        render(<FeedClient
            initialFeed={page([{ ...item('post-1', 'First'), isSaved: true }, item('post-2', 'Second', 'creator-2')])}
            initialChipId="for-you"
        />);
        expect(savePressed('post-1')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(savePressed('note-1')).toBe('true');

        // Unsaved here; For you still holds the post as it arrived, saved.
        fireEvent.click(screen.getByText('save:post-1'));
        await waitFor(() => expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'unsave' })));

        fireEvent.click(screen.getByRole('button', { name: 'For you' }));
        expect(await screen.findByText('Second')).toBeInTheDocument();
        expect(savePressed('post-1')).toBe('false');

        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(savePressed('note-1')).toBe('true');
    });

    // The static `/` cannot read `?chip=`, so Back from a post opened in Notes
    // used to land on For you under `/?chip=notes`.
    it('opens the lane the address names on the static page, as its snapshot left it', async () => {
        const fetchMock = holdRequests();
        writeShowcaseClientSnapshot(homeFeedSnapshotKey('text'), {
            feed: page([item('note-1', 'Note one'), { ...item('note-2', 'Note two'), isSaved: true }]),
            renderedItemCount: 2,
            savedItemIds: ['note-2'],
        });
        window.history.replaceState(null, '', '/?chip=notes');

        render(<FeedClient initialFeed={feed} initialChipId="for-you" laneFromUrl detailContext={HOME_DETAIL_CONTEXT} />);

        expect(await screen.findByText('Note two')).toBeInTheDocument();
        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-pressed', 'true');
        expect(savePressed('note-2')).toBe('true');
        expect(window.location.search).toBe('?chip=notes');
        expect(fetchMock).not.toHaveBeenCalled();

        // For you, as the page drew it, is kept for the way back: drawn at
        // once, with no lane reload. Built for everyone, it then asks for the
        // guest's own page one behind the cards.
        fireEvent.click(screen.getByRole('button', { name: 'For you' }));
        expect(screen.getByText('First')).toBeInTheDocument();
        expect(screen.queryByText('Loading this lane…')).not.toBeInTheDocument();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(isForYouPageOne(String(fetchMock.mock.calls[0]?.[0]))).toBe(true);
    });

    it('fetches the lane the address names when it has no snapshot, and not For you first', async () => {
        const fetchMock = mockFetchPage([item('note-1', 'Note one')]);
        window.history.replaceState(null, '', '/?chip=notes');

        render(<FeedClient initialFeed={null} initialChipId="for-you" laneFromUrl detailContext={HOME_DETAIL_CONTEXT} />);

        expect(await screen.findByText('Note one')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('category=text');
    });

    it('leaves the lane alone on a page that read it from the address itself', () => {
        window.history.replaceState(null, '', '/?chip=notes');

        render(<FeedClient initialFeed={feed} initialChipId="for-you" detailContext={HOME_DETAIL_CONTEXT} />);

        expect(screen.getByText('First')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'For you' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('gives the post page a way back to the lane the post was opened from', async () => {
        mockFetchPage([item('note-1', 'Note one')]);
        render(<FeedClient initialFeed={feed} initialChipId="for-you" detailContext={HOME_DETAIL_CONTEXT} />);

        const lastReturnTo = () => new URL(String(routerPush.mock.lastCall?.[0]), 'https://magicbooklet.test')
            .searchParams.get('returnTo');

        fireEvent.click(screen.getByText('open:post-1'));
        expect(lastReturnTo()).toBe('/');

        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
        fireEvent.click(await screen.findByText('open:note-1'));

        expect(routerPush).toHaveBeenLastCalledWith(expect.stringMatching(/^\/showcase\/note-1\?/));
        expect(lastReturnTo()).toBe('/?chip=notes');
    });

    // Feed ranking v4 counts `open` toward usefulness and interests; the title
    // link, a new tab and Read more used to send nothing.
    it('sends open for a post opened by its link, and navigates only for the card itself', () => {
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('opened-by-link:post-2'));

        expect(sendEventMock).toHaveBeenCalledTimes(1);
        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'open',
            sourceSurface: 'feed',
            item: expect.objectContaining({ id: 'post-2' }),
            fallbackPosition: 1,
        }));
        expect(routerPush).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('open:post-2'));

        expect(sendEventMock).toHaveBeenCalledTimes(2);
        expect(sendEventMock).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'open', item: expect.objectContaining({ id: 'post-2' }) }));
        expect(routerPush).toHaveBeenCalledTimes(1);
    });

    it('recognises the unlock code by the same name the server sends', () => {
        // The client copy exists because remix-access.ts is server-only.
        expect(REMIX_UNLOCK_REQUIRED_CODE).toBe(SERVER_REMIX_UNLOCK_REQUIRED_CODE);
    });

    it('asks a signed-out viewer to sign in before reporting or blocking', () => {
        const fetchMock = holdRequests();
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('block:post-1'));
        fireEvent.click(screen.getByText('report-user:post-1'));
        fireEvent.click(screen.getByText('report-content:post-1'));

        expect(routerPush).toHaveBeenCalledTimes(3);
        expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?returnUrl=/));
        expect(confirmMock).not.toHaveBeenCalled();
        // Nothing but the guest's own page one.
        expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => !isForYouPageOne(url))).toEqual([]);
    });

    it('blocks a creator after a confirmation, as the app does, and drops their posts', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockJsonFetch({ success: true, blocked: true });
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('block:post-1'));

        expect(await screen.findByText(/is blocked/)).toBeInTheDocument();
        expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Block this creator?', tone: 'danger' }));
        expect(fetchMock).toHaveBeenCalledWith('/api/moderation/blocks/creator-1', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        }));
        // Both of creator-1's posts leave the lane; creator-2's stays.
        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(screen.queryByText('Third')).not.toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('reports a creator with the reason and surface the app sends', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockJsonFetch({ success: true });
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('report-user:post-2'));

        expect(await screen.findByText(/Creator reported/)).toBeInTheDocument();
        // A signed-in render also reads the saved state; pick the report by its address.
        const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/moderation/reports') ?? [];
        expect(JSON.parse(String(init?.body))).toEqual({
            targetType: 'user',
            targetId: 'creator-2',
            reason: 'harassment',
            sourceSurface: 'showcase',
        });
        // Reporting a creator does not hide their posts; blocking does.
        expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('reports a post and removes it from the lane', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockJsonFetch({ success: true });
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('report-content:post-3'));

        expect(await screen.findByText('Content reported and removed from your feed.')).toBeInTheDocument();
        const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/posts/post-3/report') ?? [];
        expect(JSON.parse(String(init?.body))).toMatchObject({ reason: 'unsafe_content' });
        expect(screen.queryByText('Third')).not.toBeInTheDocument();
        expect(screen.getByText('First')).toBeInTheDocument();
    });

    // The server files the report as that delivery's `report` feed event; a
    // card the ranker never served has none to name.
    it('names the delivery a ranked card was reported from, and none for an unranked one', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockJsonFetch({ success: true });
        const ranked = {
            ...item('post-1', 'First'),
            recommendation: { deliveryId: '812', position: 0, reason: 'Based on your saves', algorithmVersion: 'for-you-rules-v4' },
        };
        render(<FeedClient initialFeed={page([ranked, item('post-2', 'Second', 'creator-2')])} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('report-content:post-1'));
        await waitFor(() => expect(screen.queryByText('First')).not.toBeInTheDocument());
        fireEvent.click(screen.getByText('report-content:post-2'));
        await waitFor(() => expect(screen.queryByText('Second')).not.toBeInTheDocument());

        const bodyTo = (url: string) => JSON.parse(String(fetchMock.mock.calls.find(([called]) => called === url)?.[1]?.body));
        expect(bodyTo('/api/posts/post-1/report')).toEqual({
            reason: 'unsafe_content',
            details: 'Reported from the web home feed.',
            deliveryId: '812',
        });
        expect(bodyTo('/api/posts/post-2/report')).toEqual({
            reason: 'unsafe_content',
            details: 'Reported from the web home feed.',
        });
    });

    it('sends nothing when the confirmation is declined', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        confirmMock.mockResolvedValue(false);
        const fetchMock = mockJsonFetch({});
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('block:post-1'));
        });

        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.filter(([url]) => url.includes('/moderation/'))).toHaveLength(0);
        expect(screen.getByText('First')).toBeInTheDocument();
    });

    it('keeps the posts and says why when the block fails', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        mockJsonFetch({ error: 'Could not update the block.' }, false, 500);
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('block:post-1'));

        expect(await screen.findByText('Could not block this creator. Could not update the block.')).toBeInTheDocument();
        expect(screen.getByText('First')).toBeInTheDocument();
    });

    // The static `/` draws page one for everyone: it has no session, and no
    // card on it a delivery, so nothing on it reached the ranker (01-2, 04-2).
    const guestPageOne = {
        ...page([
            ranked(item('post-2', 'Second', 'creator-2'), '702'),
            ranked(item('post-1', 'First'), '701'),
            ranked(item('post-9', 'Ninth', 'creator-9'), '709'),
        ]),
        feedSessionId: 'guest-session',
        pageInfo: { hasMore: true, nextOffset: 12, nextCursor: 'guest-cursor' },
    } as ShowcaseFeedPage;
    const deliveryOf = (title: string) => screen.getByText(title).closest('article')?.getAttribute('data-delivery');
    const drawnTitles = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

    it("gives a guest's drawn cards their own deliveries in place, asking once", async () => {
        // The guest's page one goes on by cursor, which the sentinel watches for.
        stubSentinel();
        const fetchMock = mockRoutedFetch((url) => (url.includes('category=text')
            ? page([item('note-1', 'Note one')])
            : url.startsWith('/api/showcase/feed?') ? guestPageOne : []));
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await waitFor(() => expect(deliveryOf('First')).toBe('701'));
        // The drawn cards keep their places; the rest of the page follows them.
        expect(drawnTitles()).toEqual(['First', 'Second', 'Third', 'Ninth']);
        expect(deliveryOf('Second')).toBe('702');
        // Not on the guest's page: as it was drawn.
        expect(deliveryOf('Third')).toBe('');

        const pageOneRequests = () => fetchMock.mock.calls.filter(([url]) => isForYouPageOne(url));
        expect(pageOneRequests()).toHaveLength(1);
        const [url, init] = pageOneRequests()[0];
        expect(url).toContain('limit=12');
        expect(url).not.toContain('cursor=');
        // The feed cookie names the guest; there is no token to send.
        expect(init?.headers).toBeUndefined();

        // Away and back: For you comes back with its session, and asks nothing.
        fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
        expect(await screen.findByText('Note one')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'For you' }));
        expect(await screen.findByText('Ninth')).toBeInTheDocument();
        expect(pageOneRequests()).toHaveLength(1);

        // A delivered card's feedback now reaches the ranker, in the guest's session.
        fireEvent.click(screen.getByText('not-interested:post-1'));

        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'not_interested',
            feedSessionId: 'guest-session',
            item: expect.objectContaining({ id: 'post-1', recommendation: expect.objectContaining({ deliveryId: '701' }) }),
        }));
        expect(await screen.findByText('Post removed for this visit.')).toBeInTheDocument();
    });

    it("pages a guest's lane on from their own page one, without what they removed before it landed", async () => {
        const sentinel = stubSentinel();
        let answerPageOne: (body: ShowcaseFeedPage) => void = () => undefined;
        const fetchMock = vi.fn(async (url: string) => {
            const body = isForYouPageOne(url)
                ? await new Promise<ShowcaseFeedPage>((resolve) => { answerPageOne = resolve; })
                : page([item('post-13', 'Thirteenth')]);
            return { ok: true, status: 200, json: async () => body };
        });
        vi.stubGlobal('fetch', fetchMock);
        render(<FeedClient
            initialFeed={{ ...feed, pageInfo: { hasMore: true, nextOffset: 3 } } as ShowcaseFeedPage}
            initialChipId="for-you"
        />);

        fireEvent.click(screen.getByText('not-interested:post-1'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        // Paging waits for it, or it would go on by offset from the page built
        // for everyone.
        act(() => sentinel.intersect());
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => answerPageOne(guestPageOne));

        expect(deliveryOf('Second')).toBe('702');
        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(sendEventMock).not.toHaveBeenCalled();

        act(() => sentinel.intersect());

        expect(await screen.findByText('Thirteenth')).toBeInTheDocument();
        expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=guest-cursor');
    });

    it('asks for no page one of its own for a signed-in viewer, or before the session is known', async () => {
        stubSentinel();
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockRoutedFetch((url) => (url.startsWith('/api/showcase/feed?') ? guestPageOne : []));
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        // The effects ran: the signed-in saved-state lookup went out.
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/showcase/saved-state'),
            expect.anything(),
        ));
        const feedRequests = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/showcase/feed?'));
        expect(feedRequests()).toEqual([]);

        cleanup();
        auth.state = { session: null, user: null, isLoading: true };
        const { rerender } = render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        await act(async () => undefined);
        expect(feedRequests()).toEqual([]);

        // Known to be signed out: now the guest's own page one.
        auth.state = { session: null, user: null, isLoading: false };
        rerender(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        await waitFor(() => expect(feedRequests()).toHaveLength(1));
    });

    // Fast Refresh and a hidden <Activity> run every cleanup, which aborts the
    // request in flight; the effects that run again have to ask again.
    it("asks for a guest's page one again when every effect runs again before it lands", async () => {
        stubSentinel();
        const answers: Array<(body: ShowcaseFeedPage) => void> = [];
        const fetchMock = vi.fn(async () => {
            const body = await new Promise<ShowcaseFeedPage>((resolve) => { answers.push(resolve); });
            return { ok: true, status: 200, json: async () => body };
        });
        vi.stubGlobal('fetch', fetchMock);
        const inActivity = (mode: 'visible' | 'hidden') => (
            <Activity mode={mode}>
                <FeedClient initialFeed={feed} initialChipId="for-you" />
            </Activity>
        );
        const { rerender } = render(inActivity('visible'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        rerender(inActivity('hidden'));
        rerender(inActivity('visible'));
        // The positive control: the effects did run again.
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        // The aborted request's answer is not taken.
        await act(async () => answers[0](page([ranked(item('post-1', 'First'), '666')])));
        expect(deliveryOf('First')).toBe('');

        await act(async () => answers[1](guestPageOne));
        expect(deliveryOf('First')).toBe('701');
    });

    // A save re-rendered every mounted card twice, and a page every card (05-3):
    // each new items array rebuilt every card, and the feedback handler with it.
    it('re-renders only the card a save changed', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockRoutedFetch((url) => (url === '/api/showcase/save'
            ? { success: true, isSaved: true, saveCount: 1 }
            : []));
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/showcase/saved-state'),
            expect.anything(),
        ));
        await act(async () => undefined);
        cardRenders.clear();

        fireEvent.click(screen.getByText('save:post-2'));
        await waitFor(() => expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'save' })));
        await act(async () => undefined);

        expect(savePressed('post-2')).toBe('true');
        expect(cardRenders.get('post-2')).toBeGreaterThan(0);
        expect([...cardRenders.keys()]).toEqual(['post-2']);
    });

    // A new key function on every render made the windowed list subscribe its
    // scroll and resize listeners again, and read the layout, each time.
    it("keeps the list's scroll listener through a render that changes no card", async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        requestRemixMock.mockReturnValue(new Promise(() => undefined));
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);
        await act(async () => undefined);
        const subscribe = vi.spyOn(window, 'addEventListener');

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        // The feed rendered again: the pill is busy with the remix ...
        expect(screen.getByText('remix:post-1')).toBeDisabled();
        // ... and the list kept the listeners it had.
        expect(subscribe.mock.calls.filter(([type]) => type === 'scroll')).toEqual([]);
        subscribe.mockRestore();
    });

    it('re-renders no card already drawn when a page arrives', async () => {
        const sentinel = stubSentinel();
        mockRoutedFetch((url) => (url.startsWith('/api/showcase/feed?')
            ? { ...page([ranked(item('post-4', 'Fourth'), '904')]), feedSessionId: 'ranked-session' }
            : []));
        render(<FeedClient
            initialFeed={{ ...rankedFeed, pageInfo: { hasMore: true, nextOffset: 3, nextCursor: 'rank-cursor' } } as ShowcaseFeedPage}
            initialChipId="for-you"
        />);
        cardRenders.clear();

        act(() => sentinel.intersect());

        expect(await screen.findByText('Fourth')).toBeInTheDocument();
        expect([...cardRenders.keys()]).toEqual(['post-4']);
    });

    // The post page credits a report or a comment to the delivery its address
    // names (C2), so the way in from a card carries the card's.
    it("opens a ranked card's post with the card's delivery, at the address it warmed", () => {
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" detailContext={HOME_DETAIL_CONTEXT} />);

        fireEvent.click(screen.getByText('warm:post-2'));
        fireEvent.click(screen.getByText('open:post-2'));

        const opened = String(routerPush.mock.lastCall?.[0]);
        expect(new URL(opened, 'https://magicbooklet.test').searchParams.get('delivery')).toBe('902');
        expect(router.prefetch).toHaveBeenCalledTimes(1);
        expect(router.prefetch).toHaveBeenCalledWith(opened);
    });

    it("sends an unlock-gated remix to the recipe with the card's delivery", async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        requestRemixMock.mockRejectedValue(new ShowcaseRemixRequestError('Unlock needed', 403, 'REMIX_UNLOCK_REQUIRED'));
        render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        await waitFor(() => expect(routerPush).toHaveBeenCalledWith(
            '/showcase/post-1?from=community&returnTo=%2Ffeed&delivery=901#recipe',
        ));
    });

    // The creator sells the remix with a recipe that costs nothing: the app's
    // Remix takes it in the same tap, and the Home card's now does (01-4).
    const freeUnlockFeed = page([{
        ...item('post-1', 'First'),
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        asset: {
            id: 'bundle-1',
            postId: 'post-1',
            title: 'First',
            accessMode: 'free',
            priceUsdCents: 0,
            previewText: '',
            allowRemix: true,
        },
    } as ShowcaseFeedItem]);

    it('takes a free recipe on the way to the remix, in the same tap', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        const fetchMock = mockRoutedFetch((url) => (url.endsWith('/unlock-free') ? { success: true, free: true } : []));
        requestRemixMock.mockResolvedValue({ redirectTo: '/create-image?remix=post-1' });
        render(<FeedClient initialFeed={freeUnlockFeed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/create-image?remix=post-1'));
        const claim = fetchMock.mock.calls.findIndex(([url]) => url === '/api/posts/post-1/resource-bundle/unlock-free');
        expect(fetchMock.mock.calls[claim]?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer token' } });
        // Claimed first, then remixed.
        expect(fetchMock.mock.invocationCallOrder[claim]).toBeLessThan(requestRemixMock.mock.invocationCallOrder[0]);
        expect(requestRemixMock).toHaveBeenCalledWith({ accessToken: 'token', postId: 'post-1' });
    });

    it('starts no remix when the free recipe cannot be taken, and says why', async () => {
        auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/unlock-free')
            ? { ok: false, status: 400, json: async () => ({ error: 'This bundle requires payment.' }) }
            : { ok: true, status: 200, json: async () => [] })));
        render(<FeedClient initialFeed={freeUnlockFeed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('remix:post-1'));
        });

        expect(await screen.findByText('This bundle requires payment.')).toBeInTheDocument();
        expect(requestRemixMock).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.getByText('remix:post-1')).not.toBeDisabled();
    });

    // Undo for Not interested and Hide (D7, 2026-10-14): the card's place
    // offers it for five seconds; the card comes back where it was.
    describe('Undo', () => {
        /** The lane as drawn, top to bottom, with the row where a card left. */
        const laneOrder = () => Array.from(
            document.querySelectorAll('h3, [role="group"]'),
            (element) => (element.tagName === 'H3' ? element.textContent : 'Hidden · Undo'),
        );
        const undoRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
            .filter(([url]) => String(url) === '/api/showcase/feed/feedback/undo');
        const signIn = () => {
            auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        };

        afterEach(() => {
            vi.useRealTimers();
        });

        it("shows Hidden · Undo in the card's place for five seconds, then lets the removal stand", async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            signIn();
            const fetchMock = mockRoutedFetch(() => []);
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('not-interested:post-2'));

            expect(laneOrder()).toEqual(['First', 'Hidden · Undo', 'Third']);
            expect(screen.getByRole('group', { name: 'Post hidden' })).toHaveTextContent('Hidden · Undo');
            await act(async () => undefined);
            expect(screen.getByText('Thanks. We’ll show you fewer posts like that.')).toBeInTheDocument();

            act(() => vi.advanceTimersByTime(FEED_REMOVAL_UNDO_MS - 1));
            expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
            act(() => vi.advanceTimersByTime(1));

            expect(laneOrder()).toEqual(['First', 'Third']);
            expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
            expect(undoRequests(fetchMock)).toEqual([]);
        });

        it('puts the card back where it was, and takes the preference back on the server once the hide is stored', async () => {
            signIn();
            let storeHide: () => void = () => undefined;
            sendEventMock.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
                storeHide = () => resolve(undefined);
            }));
            const fetchMock = mockRoutedFetch((url) => (url === '/api/showcase/feed/feedback/undo'
                ? { ok: true, removed: true }
                : []));
            const { unmount } = render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('not-interested:post-2'));
            fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

            expect(laneOrder()).toEqual(['First', 'Second', 'Third']);
            // The hide is still on its way: a delete now could land first.
            await act(async () => undefined);
            expect(undoRequests(fetchMock)).toEqual([]);

            await act(async () => storeHide());

            await waitFor(() => expect(undoRequests(fetchMock)).toHaveLength(1));
            const [, init] = undoRequests(fetchMock)[0];
            expect(init?.method).toBe('POST');
            expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer token' }));
            expect(JSON.parse(String(init?.body))).toEqual({ feedbackType: 'not_interested', postId: 'post-2' });
            // Taken back: no word of fewer posts like it, and no word of failure.
            expect(screen.queryByRole('status')).not.toBeInTheDocument();

            // The visit forgot it: the page one the feed comes back to draws it.
            unmount();
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);
            expect(screen.getByText('Second')).toBeInTheDocument();
        });

        it("puts all of a hidden creator's posts back in their places", () => {
            signIn();
            mockRoutedFetch(() => []);
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('hide:post-3'));

            // The row stands where Third stood, among the cards left.
            expect(laneOrder()).toEqual(['Second', 'Hidden · Undo']);
            expect(screen.getByRole('group', { name: 'Posts from Creator creator-1 hidden' })).toBeInTheDocument();

            fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

            expect(laneOrder()).toEqual(['First', 'Second', 'Third']);
        });

        it("keeps a guest's Undo on the page: nothing is sent, and the visit forgets the removal", async () => {
            // Delivered cards: the guest's hide is sent; there is no row of theirs to take back.
            const fetchMock = mockRoutedFetch(() => []);
            const { unmount } = render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('hide:post-1'));
            expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hide_creator' }));
            fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
            await act(async () => undefined);

            expect(laneOrder()).toEqual(['First', 'Second', 'Third']);
            expect(undoRequests(fetchMock)).toEqual([]);

            unmount();
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);
            expect(screen.getByText('First')).toBeInTheDocument();
            expect(screen.getByText('Third')).toBeInTheDocument();
        });

        it('takes back the word that the post was hidden along with the post', async () => {
            signIn();
            mockRoutedFetch((url) => (url === '/api/showcase/feed/feedback/undo' ? { ok: true, removed: true } : []));
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('not-interested:post-1'));
            expect(await screen.findByText('Thanks. We\u2019ll show you fewer posts like that.')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

            expect(screen.queryByText('Thanks. We\u2019ll show you fewer posts like that.')).not.toBeInTheDocument();
            await act(async () => undefined);
            expect(screen.queryByRole('status')).not.toBeInTheDocument();
        });

        it("keeps the card on screen and says so when the server kept the preference", async () => {
            signIn();
            mockRoutedFetch((url) => (url === '/api/showcase/feed/feedback/undo' ? { ok: true, removed: false } : []));
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('not-interested:post-1'));
            fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

            expect(await screen.findByText('We couldn’t undo that. It stays hidden on your next visit.')).toBeInTheDocument();
            expect(laneOrder()).toEqual(['First', 'Second', 'Third']);
        });

        it('lets one removal stand when the next card is hidden, and offers Undo for the last below the cards', () => {
            mockRoutedFetch(() => []);
            render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

            fireEvent.click(screen.getByText('not-interested:post-1'));
            fireEvent.click(screen.getByText('not-interested:post-3'));

            expect(laneOrder()).toEqual(['Second', 'Hidden · Undo']);
            expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
        });
    });

    // "New posts" (D2, 2026-10-14): on a return to the tab five minutes or
    // more after the lane came, the newest-post probe is asked; nothing is
    // fetched into the lane before the pill's tap.
    describe('New posts', () => {
        const OPENED_AT = Date.parse('2026-07-28T12:00:00.000Z');
        let visibility: DocumentVisibilityState = 'visible';
        let newestPublishedAt = '2026-07-29T00:00:00.000Z';
        const nextPageOne = { ...page([ranked(item('post-new', 'Newest'), '950'), ...rankedFeed.items]), feedSessionId: 'next-session' } as ShowcaseFeedPage;

        const setVisibility = (next: DocumentVisibilityState) => {
            visibility = next;
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'));
            });
        };
        const comeBackAfter = async (minutes: number) => {
            setVisibility('hidden');
            vi.setSystemTime(OPENED_AT + minutes * 60_000);
            setVisibility('visible');
            await act(async () => undefined);
        };
        const mockLaneAndProbe = () => mockRoutedFetch((url) => {
            if (url.startsWith('/api/showcase/feed/newest')) return { newestPostId: 'post-new', newestPublishedAt };
            if (url.startsWith('/api/showcase/feed?')) return url.includes('category=text') ? page([item('note-1', 'Note one')]) : nextPageOne;
            return [];
        });
        const laneRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
            .map(([url]) => String(url))
            .filter((url) => url.startsWith('/api/showcase/feed?'));
        const probeRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
            .filter(([url]) => String(url).startsWith('/api/showcase/feed/newest'));

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(OPENED_AT);
            visibility = 'visible';
            newestPublishedAt = '2026-07-29T00:00:00.000Z';
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
            auth.state = { session: { access_token: 'token' }, user: { id: 'viewer-1' } };
        });

        afterEach(() => {
            vi.useRealTimers();
            delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
            Reflect.deleteProperty(window, 'scrollY');
        });

        it('shows on a return five minutes after the lane came, asks for no lane page, and its tap loads page one from the top', async () => {
            const fetchMock = mockLaneAndProbe();
            const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            await comeBackAfter(NEW_POSTS_PROBE_AFTER_MS / 60_000);

            const pill = await screen.findByRole('button', { name: 'New posts' });
            expect(probeRequests(fetchMock)).toHaveLength(1);
            const [probeUrl, probeInit] = probeRequests(fetchMock)[0];
            expect(probeUrl).toBe('/api/showcase/feed/newest?category=all');
            // Asked as anyone: no token goes with it.
            expect(probeInit?.headers).toBeUndefined();
            expect(laneRequests(fetchMock)).toEqual([]);
            expect(screen.queryByText('Newest')).not.toBeInTheDocument();

            Object.defineProperty(window, 'scrollY', { configurable: true, value: 1_200 });
            fireEvent.click(pill);

            expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
            expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
            expect(await screen.findByText('Newest')).toBeInTheDocument();
            expect(laneRequests(fetchMock)).toHaveLength(1);
            expect(laneRequests(fetchMock)[0]).toContain('offset=0');
            expect(laneRequests(fetchMock)[0]).toContain('sort=for-you');
            scrollTo.mockRestore();
        });

        it('takes an embedded lane to its own top, under the shell bar, without motion for a reader who asks for none', async () => {
            mockLaneAndProbe();
            const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
            vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
                matches: query === '(prefers-reduced-motion: reduce)',
                media: query,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })));
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" variant="embedded" />);

            await comeBackAfter(6);
            Object.defineProperty(window, 'scrollY', { configurable: true, value: 1_200 });
            fireEvent.click(await screen.findByRole('button', { name: 'New posts' }));

            // jsdom lays nothing out: the lane's top is where the page is, at 1,200 px.
            expect(scrollTo).toHaveBeenCalledWith({ top: 1_120, behavior: 'auto' });
            scrollTo.mockRestore();
        });

        it('shows nothing within five minutes, nor when the newest post is one the lane holds', async () => {
            const fetchMock = mockLaneAndProbe();
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            await comeBackAfter(4);
            expect(probeRequests(fetchMock)).toEqual([]);

            newestPublishedAt = '2026-07-28T00:00:00.000Z';
            await comeBackAfter(6);
            await waitFor(() => expect(probeRequests(fetchMock)).toHaveLength(1));
            await act(async () => undefined);

            expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
            expect(laneRequests(fetchMock)).toEqual([]);
        });

        it('never asks about the Recent lane, and asks about For you again once back on it', async () => {
            const fetchMock = mockLaneAndProbe();
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);

            fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
            expect(await screen.findByText('Newest')).toBeInTheDocument();
            await comeBackAfter(30);
            expect(probeRequests(fetchMock)).toEqual([]);

            // The positive control: For you, loaded afresh on the way back
            // (its kept copy is too old), is asked about five minutes later.
            fireEvent.click(screen.getByRole('button', { name: 'For you' }));
            await waitFor(() => expect(laneRequests(fetchMock)).toHaveLength(2));
            await comeBackAfter(34);
            expect(probeRequests(fetchMock)).toEqual([]);
            await comeBackAfter(35);
            await waitFor(() => expect(probeRequests(fetchMock)).toHaveLength(1));
        });

        it('goes away with a lane change', async () => {
            mockLaneAndProbe();
            render(<FeedClient initialFeed={rankedFeed} initialChipId="for-you" />);
            await comeBackAfter(6);
            expect(await screen.findByRole('button', { name: 'New posts' })).toBeInTheDocument();

            fireEvent.click(screen.getByRole('button', { name: 'Notes' }));

            expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
            expect(await screen.findByText('Note one')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
        });
    });
});
