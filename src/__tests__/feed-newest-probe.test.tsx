import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    feedNewestCategoryFor,
    NEW_POSTS_PROBE_AFTER_MS,
    newestCreatedAtOf,
    useNewPostsProbe,
    type NewPostsProbeLane,
} from '@/lib/feed-newest-probe';

const OPENED_AT = Date.parse('2026-10-14T06:00:00.000Z');
const LANE_NEWEST_AT = Date.parse('2026-10-14T05:00:00.000Z');
const forYou: NewPostsProbeLane = { key: 'for-you', category: 'all' };

type ProbeProps = Parameters<typeof useNewPostsProbe>[0];

describe('the "New posts" probe', () => {
    let visibility: DocumentVisibilityState = 'visible';
    let newestPublishedAt: string | null = '2026-10-14T05:30:00.000Z';
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

    const probeRequests = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/showcase/feed/newest'));
    const setVisibility = (next: DocumentVisibilityState) => {
        visibility = next;
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
    };
    /** The tab is put away, and brought back `minutes` after the lane opened. */
    const comeBackAfter = async (minutes: number) => {
        setVisibility('hidden');
        vi.setSystemTime(OPENED_AT + minutes * 60_000);
        setVisibility('visible');
        await act(async () => undefined);
    };
    const renderProbe = (props: Partial<ProbeProps> = {}) => renderHook(
        (current: ProbeProps) => useNewPostsProbe(current),
        { initialProps: { lane: forYou, laneFetchedAt: null, newestKnownAt: LANE_NEWEST_AT, ...props } },
    );

    beforeEach(() => {
        // Only the clock: the requests still settle on real timers.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPENED_AT);
        visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
        newestPublishedAt = '2026-10-14T05:30:00.000Z';
        fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
            newestPostId: newestPublishedAt ? 'post-new' : null,
            newestPublishedAt,
        })));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    });

    it('asks nothing while the page stays in view, and nothing on a return within five minutes', async () => {
        const { result } = renderProbe();
        await act(async () => undefined);
        expect(probeRequests()).toEqual([]);

        await comeBackAfter(4.9);

        expect(probeRequests()).toEqual([]);
        expect(result.current.hasNewer).toBe(false);
    });

    it('asks once, with no token, on a return five minutes or more after the lane came, and shows the pill for a newer post', async () => {
        const { result } = renderProbe();

        await comeBackAfter(NEW_POSTS_PROBE_AFTER_MS / 60_000);

        await waitFor(() => expect(result.current.hasNewer).toBe(true));
        expect(probeRequests()).toHaveLength(1);
        const [url, init] = probeRequests()[0];
        expect(url).toBe('/api/showcase/feed/newest?category=all');
        expect(init?.headers).toBeUndefined();
    });

    it('shows nothing when the newest post is one the lane already holds', async () => {
        newestPublishedAt = new Date(LANE_NEWEST_AT).toISOString();
        const { result } = renderProbe();

        await comeBackAfter(6);

        await waitFor(() => expect(probeRequests()).toHaveLength(1));
        await act(async () => undefined);
        expect(result.current.hasNewer).toBe(false);
    });

    it('never asks for a lane with no pill', async () => {
        renderProbe({ lane: null });

        await comeBackAfter(30);

        expect(probeRequests()).toEqual([]);
    });

    it('counts the age of a lane from its own fetch', async () => {
        // Fetched two minutes after the page opened: five minutes after the
        // open is three after the fetch.
        const { result } = renderProbe({ laneFetchedAt: OPENED_AT + 2 * 60_000 });

        await comeBackAfter(5);
        expect(probeRequests()).toEqual([]);

        await comeBackAfter(7);
        await waitFor(() => expect(result.current.hasNewer).toBe(true));
        expect(probeRequests()).toHaveLength(1);
    });

    it('asks once for a page back from the back/forward cache, which says so twice', async () => {
        renderProbe();

        act(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        });
        setVisibility('hidden');
        vi.setSystemTime(OPENED_AT + 20 * 60_000);
        act(() => {
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        setVisibility('visible');
        await act(async () => undefined);

        await waitFor(() => expect(probeRequests()).toHaveLength(1));
    });

    it('hides the pill for another lane, or for the lane loaded afresh', async () => {
        const { result, rerender } = renderProbe({ laneFetchedAt: OPENED_AT });
        await comeBackAfter(6);
        await waitFor(() => expect(result.current.hasNewer).toBe(true));

        rerender({ lane: { key: 'notes', category: 'text' }, laneFetchedAt: OPENED_AT, newestKnownAt: LANE_NEWEST_AT });
        expect(result.current.hasNewer).toBe(false);

        rerender({ lane: forYou, laneFetchedAt: OPENED_AT, newestKnownAt: LANE_NEWEST_AT });
        expect(result.current.hasNewer).toBe(true);

        rerender({ lane: forYou, laneFetchedAt: OPENED_AT + 6 * 60_000, newestKnownAt: LANE_NEWEST_AT });
        expect(result.current.hasNewer).toBe(false);
    });

    // A ranked lane need not hold the newest post there is: taken afresh
    // after the pill, it may still not, and the pill came back for that same
    // post at every return.
    it('does not offer the same post again once the reader has taken the lane afresh for it', async () => {
        const { result, rerender } = renderProbe();
        await comeBackAfter(6);
        await waitFor(() => expect(result.current.hasNewer).toBe(true));

        act(() => result.current.dismiss());
        rerender({ lane: forYou, laneFetchedAt: OPENED_AT + 6 * 60_000, newestKnownAt: LANE_NEWEST_AT });
        expect(result.current.hasNewer).toBe(false);

        await comeBackAfter(12);
        await waitFor(() => expect(probeRequests()).toHaveLength(2));
        await act(async () => undefined);
        expect(result.current.hasNewer).toBe(false);

        // Something newer still: the pill again.
        newestPublishedAt = '2026-10-14T06:10:00.000Z';
        await comeBackAfter(18);
        await waitFor(() => expect(result.current.hasNewer).toBe(true));
    });

    it('drops an answer that comes after the reader moved to another lane', async () => {
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
        const { result, rerender } = renderProbe();
        await comeBackAfter(6);
        expect(probeRequests()).toHaveLength(1);

        rerender({ lane: { key: 'notes', category: 'text' }, laneFetchedAt: null, newestKnownAt: LANE_NEWEST_AT });
        await act(async () => answer(new Response(JSON.stringify({ newestPostId: 'post-new', newestPublishedAt: '2026-10-14T05:30:00.000Z' }))));
        rerender({ lane: forYou, laneFetchedAt: null, newestKnownAt: LANE_NEWEST_AT });

        expect(result.current.hasNewer).toBe(false);
    });

    it('names a lane by what the probe can ask about, and finds the newest post a lane holds', () => {
        expect(feedNewestCategoryFor('all')).toBe('all');
        expect(feedNewestCategoryFor('text')).toBe('text');
        expect(feedNewestCategoryFor('media')).toBe('media');
        expect(feedNewestCategoryFor('image')).toBe('media');
        expect(feedNewestCategoryFor('video')).toBe('media');

        expect(newestCreatedAtOf([])).toBeNull();
        expect(newestCreatedAtOf([
            { createdAt: '2026-10-14T05:00:00.000Z' },
            { createdAt: '2026-10-14T05:30:00.123456+00:00' },
            { createdAt: 'not a time' },
        ])).toBe(Date.parse('2026-10-14T05:30:00.123Z'));
    });
});
