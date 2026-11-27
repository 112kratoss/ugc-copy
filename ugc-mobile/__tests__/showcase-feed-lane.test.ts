import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FEED_WINDOW_PAGE_LIMIT } from '../lib/feed-page-window';
import { HOME_FEED_CHIPS } from '../lib/home-feed-view-model';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';

import {
  EXPLORE_READ_AHEAD_FILTERS,
  noteShowcaseFeedReadAheadSupport,
  resetExploreReadAheadForTests,
  startExploreReadAhead,
} from '../lib/explore-read-ahead';
import {
  FRESH_RANKING_TTL_MS,
  isFreshRankingRequested,
  requestFreshRanking,
  resetFreshRankingForTests,
  runLaneRefresh,
  type LaneRefreshInFlight,
} from '../lib/feed-fresh-ranking';
import { installRankedFirstPageDrain } from '../lib/feed-ranked-page-drain';
import {
  createShowcaseFeedQueryKey,
  getShowcaseFeedPageParams,
  type ShowcaseFeedFilters,
} from '../lib/showcase-feed-query';
import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  getReelEndSlideState,
  parseShowcaseFeedLane,
  readViewerLane,
  serializeShowcaseFeedLane,
  showcaseFeedLaneQueryOptions,
} from '../lib/showcase-feed-lane';

/** Explore's lanes as its screen builds them: a filter's params, media only, and the tool. */
const EXPLORE_LANES: ShowcaseFeedFilters[] = [
  { category: 'media' },
  { unlock: 'with-unlock', category: 'media' },
  { unlock: 'free', category: 'media' },
  { unlock: 'paid', category: 'media' },
  { resource: 'remix', category: 'media' },
  { unlock: 'free', category: 'media', tool: 'kling-2-6' },
];

describe('a lane as a route parameter', () => {
  it.each([
    ...EXPLORE_LANES.map((filters) => ['Explore', filters] as const),
    ...HOME_FEED_CHIPS.map((chip) => [`Home ${chip.id}`, chip.filters] as const),
  ])('names the very query the %s grid pages', (_grid, filters) => {
    // The reel reads the grid's own pages only if the route rebuilds the
    // grid's key exactly, for whichever reader is signed in.
    const lane = parseShowcaseFeedLane(serializeShowcaseFeedLane(filters));
    expect(lane).not.toBeNull();
    for (const viewer of ['user-1', null]) {
      expect(showcaseFeedLaneQueryOptions({ getShowcaseFeed: vi.fn() }, lane!, viewer).queryKey)
        .toEqual(createShowcaseFeedQueryKey(filters, viewer));
    }
  });

  it('writes the sort and every filter that is not its default, and survives any tool name', () => {
    expect(serializeShowcaseFeedLane({ category: 'media', unlock: 'free' })).toBe('sort:for-you,category:media,unlock:free');
    expect(serializeShowcaseFeedLane({ sort: 'recent' })).toBe('sort:recent');
    const odd = { category: 'media', tool: 'a,b:c d' } as const;
    expect(parseShowcaseFeedLane(serializeShowcaseFeedLane(odd))).toMatchObject({ tool: 'a,b:c d', category: 'media' });
  });

  it('reads nothing it did not write', () => {
    for (const value of [null, '', 'category:media', 'sort:sideways', 'sort:for-you,colour:red', 'sort:for-you,unlock:', 'sort', 'sort:%E0%A4%A']) {
      expect(parseShowcaseFeedLane(value)).toBeNull();
    }
  });

  it('is read only by a showcase-feed reel; a link with no lane loads its own window', () => {
    const lane = serializeShowcaseFeedLane({ category: 'media' });
    expect(readViewerLane('showcase-feed', lane)).toMatchObject({ category: 'media', sort: 'for-you' });
    expect(readViewerLane('showcase-feed', null)).toBeNull();
    expect(readViewerLane('creator-profile', lane)).toBeNull();
    expect(readViewerLane('profile-saved', lane)).toBeNull();
  });
});

describe('the lane query', () => {
  it("pages a lane the way its grid does: Home's Recent keeps a window, ranked lanes do not", () => {
    const api = { getShowcaseFeed: vi.fn() };
    expect(showcaseFeedLaneQueryOptions(api, { sort: 'recent' }, 'user-1').maxPages).toBe(FEED_WINDOW_PAGE_LIMIT);
    expect(showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1').maxPages).toBe(0);
    expect(showcaseFeedLaneQueryOptions(api, { category: 'media' }, 'user-1').maxPages).toBe(0);
  });

  // Audit 02-2: a refetch on return re-ranked every loaded page under the
  // reader's thumb, and served up to 60 deliveries nobody saw.
  it('reads a ranked lane again only when asked; Recent keeps the focus and mount defaults', () => {
    const api = { getShowcaseFeed: vi.fn() };
    for (const filters of [{}, { sort: 'for-you' }, { category: 'media' }, { sort: 'top-saves' }] as ShowcaseFeedFilters[]) {
      expect(showcaseFeedLaneQueryOptions(api, filters, 'user-1'), JSON.stringify(filters))
        .toMatchObject({ refetchOnWindowFocus: false, refetchOnMount: false });
    }

    const recent = showcaseFeedLaneQueryOptions(api, { sort: 'recent' }, 'user-1');
    expect(recent).not.toHaveProperty('refetchOnWindowFocus');
    expect(recent).not.toHaveProperty('refetchOnMount');
  });

  // Owner, 2026-11-27: "some other media is there in the explore screen a few
  // seconds ago". A filter or chip the reader came back to more than five
  // minutes after its lane was read drew the lane as it was left, then read
  // every loaded page again as a new ranked session and replaced them.
  describe('a lane the reader comes back to, six minutes after it was read', () => {
    const lanePage = (ids: string[]) => ({ success: true, items: ids.map((id) => ({ id })), feedSessionId: 'session-1' });
    const SIX_MINUTES = 6 * 60_000;

    async function comeBackTo(filters: ShowcaseFeedFilters, away: ShowcaseFeedFilters) {
      const readAt = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(readAt + SIX_MINUTES);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const api = { getShowcaseFeed: vi.fn(async () => lanePage(['read-again'])) };
      const lane = showcaseFeedLaneQueryOptions(api as never, filters, 'user-1');
      const other = showcaseFeedLaneQueryOptions(api as never, away, 'user-1');
      client.setQueryData(lane.queryKey, { pages: [lanePage(['a', 'b']), lanePage(['c'])], pageParams: [{ offset: 0 }, { offset: 12 }] }, { updatedAt: readAt });
      client.setQueryData(other.queryKey, { pages: [lanePage(['x'])], pageParams: [{ offset: 0 }] }, { updatedAt: readAt + SIX_MINUTES });

      // The screen's one reader, moved from the other lane back onto this one.
      const observer = new InfiniteQueryObserver(client, other as never);
      const unsubscribe = observer.subscribe(() => undefined);
      observer.setOptions(lane as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      unsubscribe();
      vi.useRealTimers();

      const data = client.getQueryData<{ pages: Array<{ items: Array<{ id: string }> }> }>(lane.queryKey);
      return { reads: api.getShowcaseFeed.mock.calls.length, ids: data?.pages.map((page) => page.items.map((item) => item.id)) };
    }

    it.each([
      ['Explore All', { category: 'media' }, { category: 'media', unlock: 'free' }],
      ['Home For You', {}, { category: 'text' }],
    ] as Array<[string, ShowcaseFeedFilters, ShowcaseFeedFilters]>)('%s is drawn as it was left, and not read again', async (_lane, filters, away) => {
      await expect(comeBackTo(filters, away)).resolves.toEqual({ reads: 0, ids: [['a', 'b'], ['c']] });
    });

    it("Home's Recent, a timeline, is read again", async () => {
      const back = await comeBackTo({ sort: 'recent' }, {});
      expect(back.reads).toBeGreaterThan(0);
    });
  });

  // Review follow-up 2: a For you page one starts a ranked session, whose seen
  // check reads the impressions recorded by then; no other sort has one.
  describe('page one of a ranked lane', () => {
    function heldDrain() {
      let release!: () => void;
      const drain = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
      installRankedFirstPageDrain(drain);
      return { drain, release: () => release() };
    }

    it('is asked for only once the queued feed events are recorded, on every reader and lane switch', async () => {
      const { drain, release } = heldDrain();
      try {
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        for (const filters of [{}, { category: 'media' }, { sort: 'for-you', unlock: 'free' }] as ShowcaseFeedFilters[]) {
          api.getShowcaseFeed.mockClear();
          drain.mockClear();
          const reading = showcaseFeedLaneQueryOptions(api, filters, 'user-1').queryFn({ pageParam: { offset: 0 } });
          await Promise.resolve();
          await Promise.resolve();
          expect(drain, JSON.stringify(filters)).toHaveBeenCalledTimes(1);
          expect(api.getShowcaseFeed).not.toHaveBeenCalled();
          release();
          await reading;
          expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
        }
      } finally {
        installRankedFirstPageDrain(null);
      }
    });

    it('is not held when Explore claims a ranking read ahead, which was ranked already', async () => {
      const { drain } = heldDrain();
      noteShowcaseFeedReadAheadSupport({ sort: 'for-you' }, { readAheadSupported: true });
      try {
        startExploreReadAhead({
          api: { prepareShowcaseFeedReadAhead: vi.fn(async () => ({ readAhead: { token: 'read-ahead-1', expiresInMs: 60_000 } })) },
          identityUserId: 'user-1',
          queryClient: new QueryClient(),
        });
        // Answered before Explore opens: nothing to wait for, and no drain started.
        await Promise.resolve();
        await Promise.resolve();
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        await showcaseFeedLaneQueryOptions(api, EXPLORE_READ_AHEAD_FILTERS, 'user-1').queryFn({ pageParam: { offset: 0 } });

        expect(drain).not.toHaveBeenCalled();
        expect(api.getShowcaseFeed).toHaveBeenCalledWith(expect.objectContaining({ readAheadToken: 'read-ahead-1' }));
      } finally {
        resetExploreReadAheadForTests();
        installRankedFirstPageDrain(null);
      }
    });

    function readAheadAnsweringAfter(ms: number, answer: { readAhead: { token: string; expiresInMs: number } | null }) {
      noteShowcaseFeedReadAheadSupport({ sort: 'for-you' }, { readAheadSupported: true });
      startExploreReadAhead({
        api: {
          prepareShowcaseFeedReadAhead: vi.fn(() => new Promise<typeof answer>((resolve) => {
            setTimeout(() => resolve(answer), ms);
          })),
        },
        identityUserId: 'user-1',
        queryClient: new QueryClient(),
      });
    }

    it('is not waited for when a read-ahead still under way comes back with its token, however late', async () => {
      vi.useFakeTimers();
      const { release } = heldDrain();
      try {
        readAheadAnsweringAfter(4_500, { readAhead: { token: 'read-ahead-1', expiresInMs: 60_000 } });
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        void showcaseFeedLaneQueryOptions(api, EXPLORE_READ_AHEAD_FILTERS, 'user-1').queryFn({ pageParam: { offset: 0 } });

        await vi.advanceTimersByTimeAsync(4_500);

        // The queued events are still being sent; the claim does not wait for them.
        expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
        expect(api.getShowcaseFeed).toHaveBeenCalledWith(expect.objectContaining({ readAheadToken: 'read-ahead-1' }));
      } finally {
        release();
        resetExploreReadAheadForTests();
        installRankedFirstPageDrain(null);
        vi.useRealTimers();
      }
    });

    it('runs alongside the wait for a read-ahead, so a wait that ends with no token is not then followed by it', async () => {
      vi.useFakeTimers();
      const drain = vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 1_500); }));
      installRankedFirstPageDrain(drain);
      try {
        // The read-ahead outlasts the drain: the page is asked for the moment it answers.
        readAheadAnsweringAfter(3_000, { readAhead: null });
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        void showcaseFeedLaneQueryOptions(api, EXPLORE_READ_AHEAD_FILTERS, 'user-1').queryFn({ pageParam: { offset: 0 } });
        await vi.advanceTimersByTimeAsync(0);
        expect(drain).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_999);
        expect(api.getShowcaseFeed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
        expect(api.getShowcaseFeed.mock.calls[0]).not.toEqual([expect.objectContaining({ readAheadToken: expect.anything() })]);

        // The drain outlasts the read-ahead: the fresh ranking still waits for the queued events.
        resetExploreReadAheadForTests();
        drain.mockClear();
        readAheadAnsweringAfter(500, { readAhead: null });
        const again = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        void showcaseFeedLaneQueryOptions(again, EXPLORE_READ_AHEAD_FILTERS, 'user-1').queryFn({ pageParam: { offset: 0 } });
        await vi.advanceTimersByTimeAsync(1_499);
        expect(drain).toHaveBeenCalledTimes(1);
        expect(again.getShowcaseFeed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(again.getShowcaseFeed).toHaveBeenCalledTimes(1);
      } finally {
        resetExploreReadAheadForTests();
        installRankedFirstPageDrain(null);
        vi.useRealTimers();
      }
    });

    it('is not held for a next page, nor for a lane with no seen check (Recent, the top lists)', async () => {
      const { drain } = heldDrain();
      try {
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        await showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1').queryFn({ pageParam: { cursor: 'cursor-2', feedSessionId: 'session-1' } });
        for (const sort of ['recent', 'top-saves', 'top-remixes', 'top-sales'] as const) {
          await showcaseFeedLaneQueryOptions(api, { sort }, 'user-1').queryFn({ pageParam: { offset: 0 } });
        }
        expect(drain).not.toHaveBeenCalled();
        expect(api.getShowcaseFeed).toHaveBeenCalledTimes(5);
      } finally {
        installRankedFirstPageDrain(null);
      }
    });
  });

  describe("a reader's own refresh", () => {
    const freshQuery = mobileApiContract.endpoints.getShowcaseFeed.freshFirstPage.query;
    /** The feed read with its parameters typed, so a test can read what each call sent. */
    const feedApi = () => ({ getShowcaseFeed: vi.fn(async (_params?: Record<string, unknown>) => ({ items: [] })) });

    beforeEach(() => {
      resetFreshRankingForTests();
    });

    it('asks the next first page of that lane for a fresh ranking, spent once it is answered', async () => {
      const api = feedApi();
      const options = showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1');

      requestFreshRanking({ sort: 'for-you' }, 'user-1');
      await options.queryFn({ pageParam: { offset: 0 } });
      // A read nobody asked for (an invalidation, a mount) is served as before.
      await options.queryFn({ pageParam: { offset: 0 } });

      expect(api.getShowcaseFeed.mock.calls[0][0]).toMatchObject({ fresh: Number(freshQuery.fresh), offset: 0, sort: 'for-you' });
      expect(api.getShowcaseFeed.mock.calls[1][0]).not.toHaveProperty('fresh');
    });

    it('asks again on the retry of a read that failed', async () => {
      const api = feedApi();
      api.getShowcaseFeed.mockRejectedValueOnce(new Error('offline'));
      const options = showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1');

      requestFreshRanking({ sort: 'for-you' }, 'user-1');
      await expect(options.queryFn({ pageParam: { offset: 0 } })).rejects.toThrow('offline');
      await options.queryFn({ pageParam: { offset: 0 } });

      expect(api.getShowcaseFeed.mock.calls[1][0]).toMatchObject({ fresh: 1 });
      expect(isFreshRankingRequested({ sort: 'for-you' }, 'user-1')).toBe(false);
    });

    it('lets a request no read took lapse, so a read long after is served as before', async () => {
      const api = feedApi();
      requestFreshRanking({ sort: 'for-you' }, 'user-1', Date.now() - FRESH_RANKING_TTL_MS - 1);

      await showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1').queryFn({ pageParam: { offset: 0 } });

      expect(api.getShowcaseFeed.mock.calls[0][0]).not.toHaveProperty('fresh');
    });

    it('leaves a next page to its session, and another lane or viewer to its own refresh', async () => {
      const api = feedApi();
      requestFreshRanking({ sort: 'for-you' }, 'user-1');

      await showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1').queryFn({ pageParam: { cursor: 'cursor-2', feedSessionId: 'session-1' } });
      await showcaseFeedLaneQueryOptions(api, { sort: 'for-you', category: 'text' }, 'user-1').queryFn({ pageParam: { offset: 0 } });
      await showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-2').queryFn({ pageParam: { offset: 0 } });
      for (const [params] of api.getShowcaseFeed.mock.calls) expect(params).not.toHaveProperty('fresh');

      // Still waiting for the read it was asked for.
      await showcaseFeedLaneQueryOptions(api, { sort: 'for-you' }, 'user-1').queryFn({ pageParam: { offset: 0 } });
      expect(api.getShowcaseFeed.mock.calls[3][0]).toMatchObject({ fresh: 1 });
    });

    describe('one refresh at a time', () => {
      const lane = { sort: 'for-you' } as const;

      it('lets a second refresh while the first is out wait for it, rather than read and rank again', async () => {
        const inFlight: LaneRefreshInFlight = { current: null };
        let finish: () => void = () => undefined;
        const start = vi.fn(() => new Promise<void>((resolve) => {
          finish = resolve;
        }));

        const pull = runLaneRefresh(inFlight, { filters: lane, identityUserId: 'user-1', lanePages: 2, start });
        // "New posts" tapped before the pull's page landed.
        const pill = runLaneRefresh(inFlight, { filters: lane, identityUserId: 'user-1', lanePages: 1, start });

        expect(pill).toBe(pull);
        expect(start).toHaveBeenCalledTimes(1);
        finish();
        await pull;
        // Over, so the next refresh starts a read of its own.
        await runLaneRefresh(inFlight, { filters: lane, identityUserId: 'user-1', lanePages: 1, start: async () => undefined });
        expect(inFlight.current).toBeNull();
      });

      it('asks a fresh ranking only for a lane with pages: a lane still loading has its read on the way', () => {
        const inFlight: LaneRefreshInFlight = { current: null };
        void runLaneRefresh(inFlight, { filters: lane, identityUserId: 'user-1', lanePages: 0, start: async () => undefined });
        expect(isFreshRankingRequested(lane, 'user-1')).toBe(false);

        void runLaneRefresh({ current: null }, { filters: lane, identityUserId: 'user-1', lanePages: 1, start: async () => undefined });
        expect(isFreshRankingRequested(lane, 'user-1')).toBe(true);
      });

      it('never lets one lane\'s refresh stand for another\'s', () => {
        const inFlight: LaneRefreshInFlight = { current: null };
        const start = vi.fn(() => new Promise<void>(() => undefined));
        void runLaneRefresh(inFlight, { filters: lane, identityUserId: 'user-1', lanePages: 1, start });
        void runLaneRefresh(inFlight, { filters: { sort: 'recent' }, identityUserId: 'user-1', lanePages: 1, start });
        expect(start).toHaveBeenCalledTimes(2);
      });
    });

    it('sends it only where the server reads it: a For you first page', () => {
      expect(getShowcaseFeedPageParams({ sort: 'for-you', offset: 0, fresh: true })).toMatchObject({ fresh: 1 });
      expect(getShowcaseFeedPageParams({ sort: 'recent', offset: 0, fresh: true })).not.toHaveProperty('fresh');
      expect(getShowcaseFeedPageParams({ sort: 'for-you', offset: 12, fresh: true })).not.toHaveProperty('fresh');
      expect(getShowcaseFeedPageParams({ sort: 'for-you', cursor: 'cursor-2', fresh: true })).not.toHaveProperty('fresh');
    });
  });

  it("asks for the lane's next page with its cursor and session", async () => {
    const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
    const options = showcaseFeedLaneQueryOptions(api, parseShowcaseFeedLane('sort:for-you,category:media,unlock:free')!, 'user-1');
    await options.queryFn({ pageParam: { cursor: 'cursor-2', feedSessionId: 'session-1' } });
    expect(api.getShowcaseFeed).toHaveBeenCalledWith({
      limit: 12,
      sort: 'for-you',
      cursor: 'cursor-2',
      feedSessionId: 'session-1',
      category: 'media',
      unlock: 'free',
    });
  });
});

describe("what stands after a lane's last post", () => {
  const lane = { hasData: true, itemCount: 30, hasNextPage: false, isFetchNextPageError: false, isFetchingNextPage: false };

  it('closes the reel at the end of the lane, and says nothing while more posts are coming', () => {
    expect(getReelEndSlideState(lane)).toBe('end');
    expect(getReelEndSlideState({ ...lane, hasNextPage: true })).toBeNull();
    expect(getReelEndSlideState({ ...lane, hasNextPage: true, isFetchingNextPage: true })).toBeNull();
  });

  it('offers a retry for a page that failed, and shows that retry under way', () => {
    expect(getReelEndSlideState({ ...lane, hasNextPage: true, isFetchNextPageError: true })).toBe('error');
    expect(getReelEndSlideState({ ...lane, hasNextPage: true, isFetchNextPageError: true, isFetchingNextPage: true })).toBe('loading');
  });

  it('has nothing to close before the lane has loaded a post', () => {
    expect(getReelEndSlideState({ ...lane, hasData: false })).toBeNull();
    expect(getReelEndSlideState({ ...lane, itemCount: 0 })).toBeNull();
  });
});

describe('the grids hand their lane to the reel', () => {
  it.each([
    ['Explore', 'app/(tabs)/showcase.tsx', 'queryFilters'],
    ['Home', 'components/home-dashboard.tsx', 'activeChip.filters'],
  ])('%s pages its grid with the builder the reel reads, and names the lane in the push', (_grid, path, filters) => {
    const source = readFileSync(path, 'utf8');
    // Under the backend identity, guest or registered (audit 04-3).
    expect(source).toContain(`showcaseFeedLaneQueryOptions(api, ${filters}, identityUserId)`);
    expect(source).toContain(`lane: serializeShowcaseFeedLane(${filters}),`);
    // One builder: the grid builds no second copy of its own query.
    expect(source).not.toContain('getShowcaseFeedPageParams(');
  });
});
