import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { FEED_WINDOW_PAGE_LIMIT } from '../lib/feed-page-window';
import { HOME_FEED_CHIPS } from '../lib/home-feed-view-model';
import { QueryClient } from '@tanstack/react-query';

import {
  EXPLORE_READ_AHEAD_FILTERS,
  noteShowcaseFeedReadAheadSupport,
  resetExploreReadAheadForTests,
  startExploreReadAhead,
} from '../lib/explore-read-ahead';
import { installRankedFirstPageDrain } from '../lib/feed-ranked-page-drain';
import { createShowcaseFeedQueryKey, type ShowcaseFeedFilters } from '../lib/showcase-feed-query';
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
        const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
        await showcaseFeedLaneQueryOptions(api, EXPLORE_READ_AHEAD_FILTERS, 'user-1').queryFn({ pageParam: { offset: 0 } });

        expect(drain).not.toHaveBeenCalled();
        expect(api.getShowcaseFeed).toHaveBeenCalledWith(expect.objectContaining({ readAheadToken: 'read-ahead-1' }));
      } finally {
        resetExploreReadAheadForTests();
        installRankedFirstPageDrain(null);
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
