import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShowcaseFeedQueryKey } from '../lib/showcase-feed-query';
import {
  applyShowcaseFeedLaneChange,
  markShowcaseFeedLanesStale,
} from '../lib/showcase-feed-lane-refresh';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';
import { applyPostVisibilityToCaches, refreshViewerMediaCaches } from '../lib/viewer-media-cache';

const VIEWER = 'viewer-1';
const FOR_YOU = createShowcaseFeedQueryKey({ category: 'media' }, VIEWER);
const RECENT = createShowcaseFeedQueryKey({ sort: 'recent' }, VIEWER);
const FETCHED_AT = Date.parse('2026-11-27T08:00:00.000Z');

function post(id: string, creatorId = 'creator-1', overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    title: id,
    isSaved: false,
    saveCount: 0,
    creator: { id: creatorId, name: creatorId, username: creatorId, avatar: null },
    ...overrides,
  } as ShowcaseFeedItem;
}

function page(items: ShowcaseFeedItem[]): ShowcaseFeedResponse {
  return { success: true, items, feedSessionId: 'session-1' } as ShowcaseFeedResponse;
}

let queryClient: QueryClient;
type LaneRead = () => Promise<ShowcaseFeedResponse>;
let readRanked: ReturnType<typeof vi.fn<LaneRead>>;
let readRecent: ReturnType<typeof vi.fn<LaneRead>>;
let unsubscribe: Array<() => void>;

/** A lane with a reader mounted on it, as Explore's and Home's stay behind a reel or the composer. */
function mountLane(queryKey: readonly unknown[], read: LaneRead, pages: ShowcaseFeedResponse[]) {
  queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(
    queryKey,
    { pages, pageParams: pages.map((_, index) => ({ offset: index * 12 })) },
    { updatedAt: FETCHED_AT },
  );
  const observer = new InfiniteQueryObserver(queryClient, {
    queryKey,
    queryFn: read,
    initialPageParam: { offset: 0 },
    getNextPageParam: () => undefined,
    staleTime: Infinity,
    refetchOnMount: false,
  });
  unsubscribe.push(observer.subscribe(() => undefined));
}

const laneIds = (queryKey: readonly unknown[]) => queryClient
  .getQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey)?.pages.map((lanePage) => lanePage.items.map((item) => item.id));

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  unsubscribe = [];
  readRanked = vi.fn<LaneRead>(async () => page([post('reranked-1'), post('reranked-2')]));
  readRecent = vi.fn<LaneRead>(async () => page([post('new-post'), post('recent-1')]));
  mountLane(FOR_YOU, readRanked, [page([post('a'), post('b', 'creator-2')]), page([post('c'), post('d', 'creator-2')])]);
  mountLane(RECENT, readRecent, [page([post('recent-1')])]);
});

afterEach(() => {
  unsubscribe.forEach((stop) => stop());
  queryClient.clear();
});

describe('a mounted ranked lane', () => {
  it('is marked stale, not read again, so the posts under the reader stay where they are', async () => {
    await markShowcaseFeedLanesStale(queryClient);

    expect(readRanked).not.toHaveBeenCalled();
    expect(laneIds(FOR_YOU)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(queryClient.getQueryState(FOR_YOU)?.isInvalidated).toBe(true);
  });

  it('lets the timeline read again: a post just published belongs at its top', async () => {
    await markShowcaseFeedLanesStale(queryClient);

    expect(readRecent).toHaveBeenCalledTimes(1);
    expect(laneIds(RECENT)).toEqual([['new-post', 'recent-1']]);
  });

  // The reel's Delete, Archive and visibility change, and the text post page's
  // Block, all end in this refresh. It used to read every loaded page of every
  // mounted lane again, which more than two minutes after the last ranking is a
  // new order at the same scroll position.
  it('is not re-ranked by the refresh a post action ends in', async () => {
    await refreshViewerMediaCaches(queryClient, VIEWER);

    expect(readRanked).not.toHaveBeenCalled();
    expect(laneIds(FOR_YOU)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('loses a deleted or archived post in place, and nothing else moves', async () => {
    await refreshViewerMediaCaches(queryClient, VIEWER, { removedPostId: 'c' });

    expect(readRanked).not.toHaveBeenCalled();
    expect(laneIds(FOR_YOU)).toEqual([['a', 'b'], ['d']]);
  });

  it("loses a blocked creator's posts in place", async () => {
    await refreshViewerMediaCaches(queryClient, VIEWER, { blockedCreatorId: 'creator-2' });

    expect(readRanked).not.toHaveBeenCalled();
    expect(laneIds(FOR_YOU)).toEqual([['a'], ['c']]);
  });

  it('carries a save made from an action sheet without a read', async () => {
    await refreshViewerMediaCaches(queryClient, VIEWER, { saveState: { postId: 'b', isSaved: true, saveCount: 3 } });

    expect(readRanked).not.toHaveBeenCalled();
    const saved = queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(FOR_YOU)?.pages[0].items[1];
    expect(saved).toMatchObject({ id: 'b', isSaved: true, saveCount: 3 });
  });

  it('loses a post made private or unlisted, and keeps one made public', async () => {
    await applyPostVisibilityToCaches(queryClient, VIEWER, 'a', 'private');
    expect(laneIds(FOR_YOU)).toEqual([['b'], ['c', 'd']]);

    await applyPostVisibilityToCaches(queryClient, VIEWER, 'd', 'public');
    expect(laneIds(FOR_YOU)).toEqual([['b'], ['c', 'd']]);
    expect(readRanked).not.toHaveBeenCalled();
  });
});

describe('a change written into the lanes', () => {
  // Home's Remix on a post whose creator has since put remix behind a recipe.
  it("brings one post up to date where it stands, keeping the lane copy's delivery", () => {
    const delivery = { deliveryId: 'delivery-b', position: 1 };
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(FOR_YOU, {
      pages: [page([post('a'), post('b', 'creator-2', { recommendation: delivery } as Partial<ShowcaseFeedItem>)])],
      pageParams: [{ offset: 0 }],
    }, { updatedAt: FETCHED_AT });

    applyShowcaseFeedLaneChange(queryClient, { refreshedPost: post('b', 'creator-2', { title: 'Now behind a recipe' }) });

    const items = queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(FOR_YOU)?.pages[0].items;
    expect(items?.map((item) => item.id)).toEqual(['a', 'b']);
    expect(items?.[1]).toMatchObject({ title: 'Now behind a recipe', recommendation: delivery });
    expect(readRanked).not.toHaveBeenCalled();
  });

  it('keeps the age of the page it was written into, so a page owed a refresh still gets it', () => {
    applyShowcaseFeedLaneChange(queryClient, { removedPostId: 'a' });

    expect(queryClient.getQueryState(FOR_YOU)?.dataUpdatedAt).toBe(FETCHED_AT);
  });

  it('leaves a lane that does not hold the post as the very same data', () => {
    const before = queryClient.getQueryData(RECENT);

    applyShowcaseFeedLaneChange(queryClient, { removedPostId: 'a' });

    expect(queryClient.getQueryData(RECENT)).toBe(before);
  });
});
