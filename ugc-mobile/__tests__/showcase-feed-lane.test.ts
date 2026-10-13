import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { FEED_WINDOW_PAGE_LIMIT } from '../lib/feed-page-window';
import { HOME_FEED_CHIPS } from '../lib/home-feed-view-model';
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
    expect(source).toContain(`showcaseFeedLaneQueryOptions(api, ${filters}, user?.id)`);
    expect(source).toContain(`lane: serializeShowcaseFeedLane(${filters}),`);
    // One builder: the grid builds no second copy of its own query.
    expect(source).not.toContain('getShowcaseFeedPageParams(');
  });
});
