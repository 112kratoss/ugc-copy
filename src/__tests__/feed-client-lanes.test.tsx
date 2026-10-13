import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient, { forgetFeedRemovalsForTests } from '@/app/feed/FeedClient';
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
    },
}));
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
// own handlers rather than the menu's keyboard and portal plumbing.
vi.mock('@/app/feed/FeedPostCard', () => ({
    default: ({ card, isSaved, remixing, onFeedback, onRemix, onReportContent, onReportUser, onBlockUser, onToggleSave, onOpenResources, onOpenPost, onRecordOpen }: {
        card: { id: string; title: string };
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
    }) => (
        <article>
            <h3>{card.title}</h3>
            <button type="button" aria-pressed={isSaved} onClick={() => onToggleSave(card.id)}>{`save:${card.id}`}</button>
            <button type="button" onClick={() => onOpenPost(card.id)}>{`open:${card.id}`}</button>
            <button type="button" onClick={() => onRecordOpen(card.id)}>{`opened-by-link:${card.id}`}</button>
            <button type="button" onClick={() => onOpenResources?.(card.id)}>{`recipe:${card.id}`}</button>
            <button type="button" onClick={() => onFeedback(card.id, 'not_interested')}>{`not-interested:${card.id}`}</button>
            <button type="button" onClick={() => onFeedback(card.id, 'hide_creator')}>{`hide:${card.id}`}</button>
            <button type="button" disabled={remixing} onClick={() => onRemix(card.id)}>{`remix:${card.id}`}</button>
            <button type="button" onClick={() => onReportContent(card.id)}>{`report-content:${card.id}`}</button>
            <button type="button" onClick={() => onReportUser(card.id)}>{`report-user:${card.id}`}</button>
            <button type="button" onClick={() => onBlockUser(card.id)}>{`block:${card.id}`}</button>
        </article>
    ),
}));

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

const rankedFeed = page([
    ranked(item('post-1', 'First'), '901'),
    ranked(item('post-2', 'Second', 'creator-2'), '902'),
    ranked(item('post-3', 'Third'), '903'),
]);

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

describe('FeedClient lanes and card actions', () => {
    beforeEach(() => {
        routerPush.mockClear();
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
        const fetchMock = mockJsonFetch({});
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-1'));

        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(await screen.findByText('Post removed for this visit.')).toBeInTheDocument();

        fireEvent.click(screen.getByText('hide:post-2'));

        expect(screen.queryByText('Second')).not.toBeInTheDocument();
        expect(await screen.findByText('Posts from Creator creator-2 are hidden for this visit.')).toBeInTheDocument();
        expect(screen.getByText('Third')).toBeInTheDocument();
        expect(sendEventMock).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
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
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

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
        const fetchMock = mockJsonFetch({});
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

        // For you, as the page drew it, is kept for the way back.
        fireEvent.click(screen.getByRole('button', { name: 'For you' }));
        expect(await screen.findByText('First')).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
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
        const fetchMock = mockJsonFetch({});
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('block:post-1'));
        fireEvent.click(screen.getByText('report-user:post-1'));
        fireEvent.click(screen.getByText('report-content:post-1'));

        expect(routerPush).toHaveBeenCalledTimes(3);
        expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?returnUrl=/));
        expect(confirmMock).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
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
});
