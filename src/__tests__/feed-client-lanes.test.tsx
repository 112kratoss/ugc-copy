import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';
import { REMIX_UNLOCK_REQUIRED_CODE as SERVER_REMIX_UNLOCK_REQUIRED_CODE } from '@/lib/remix-access';
import { clearShowcaseClientCacheForTests } from '@/lib/showcase-client-cache';
import { REMIX_UNLOCK_REQUIRED_CODE, ShowcaseRemixRequestError } from '@/lib/showcase-remix-client';

const routerPush = vi.fn();
const routerPrefetch = vi.fn();
const auth = vi.hoisted(() => ({
    state: { session: null, user: null } as {
        session: { access_token: string } | null;
        user: { id: string } | null;
    },
}));
const sendEventMock = vi.hoisted(() => vi.fn(async () => undefined));
const requestRemixMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn<(request: { title: string; tone?: string }) => Promise<boolean>>(async () => true));

vi.mock('@/components/feedback-state', () => ({
    requestConfirmation: confirmMock,
}));

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => auth.state,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: routerPush, prefetch: routerPrefetch }),
}));

vi.mock('@/components/navigation-progress-state', () => ({
    publishNavigationStart: () => undefined,
}));

vi.mock('@/app/showcase/ShowcaseFeedInteraction', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/app/showcase/ShowcaseFeedInteraction')>()),
    sendShowcaseFeedEvent: sendEventMock,
}));

vi.mock('@/lib/showcase-remix-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/showcase-remix-client')>()),
    requestShowcaseRemix: requestRemixMock,
}));

// The card's menu and pill as plain buttons, so the test drives FeedClient's
// own handlers rather than the menu's keyboard and portal plumbing.
vi.mock('@/app/feed/FeedPostCard', () => ({
    default: ({ card, remixing, onFeedback, onRemix, onReportContent, onReportUser, onBlockUser }: {
        card: { id: string; title: string };
        remixing: boolean;
        onFeedback: (postId: string, action: 'not_interested' | 'hide_creator') => void;
        onRemix: (postId: string) => void;
        onReportContent: (postId: string) => void;
        onReportUser: (postId: string) => void;
        onBlockUser: (postId: string) => void;
    }) => (
        <article>
            <h3>{card.title}</h3>
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
        requestRemixMock.mockReset();
        confirmMock.mockReset();
        confirmMock.mockResolvedValue(true);
        auth.state = { session: null, user: null };
        window.history.replaceState(null, '', '/');
        // Each case is a fresh visit: the lane snapshot one case leaves behind
        // would otherwise be restored by the next, which is right in the
        // browser and wrong here.
        clearShowcaseClientCacheForTests();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('removes a post the viewer is not interested in and tells the ranker on the feed surface', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

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

    it('hides every post by a creator at once', () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('hide:post-1'));

        expect(screen.queryByText('First')).not.toBeInTheDocument();
        expect(screen.queryByText('Third')).not.toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
        expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hide_creator' }));
    });

    it('puts the post back when the preference cannot be saved', async () => {
        sendEventMock.mockRejectedValueOnce(new Error('offline'));
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        fireEvent.click(screen.getByText('not-interested:post-2'));

        expect(await screen.findByText(/post was restored/)).toBeInTheDocument();
        expect(screen.getByText('Second')).toBeInTheDocument();
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
