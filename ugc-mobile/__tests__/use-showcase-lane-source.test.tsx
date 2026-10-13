(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// One stable object: the registered account the reel's auth reads, or null for a guest.
const auth = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }));
vi.mock('../lib/auth', () => ({ useAuth: () => auth }));

import { ApiError } from '../lib/api-client';
import { rememberAnonymousShowcaseFeedRemoval, resetAnonymousShowcaseFeedRemovalsForTests } from '../lib/showcase-feed-events';
import { getReelEndSlideState, parseShowcaseFeedLane, serializeShowcaseFeedLane, showcaseFeedLaneQueryOptions } from '../lib/showcase-feed-lane';
import { createShowcaseFeedQueryKey, type ShowcaseFeedFilters } from '../lib/showcase-feed-query';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';
import { useShowcaseLaneSource } from '../lib/use-showcase-lane-source';

type LaneProps = Parameters<typeof useShowcaseLaneSource>[0];
type LaneResult = ReturnType<typeof useShowcaseLaneSource>;

/** Explore's Free lane, as its grid keys it. */
const FREE_LANE: ShowcaseFeedFilters = { unlock: 'free', category: 'media' };

function post(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.jpg`,
    mediaKind: 'image',
    model: 'manual',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-12T10:00:00.000Z',
    creator: { id: `creator-${id}`, username: id, name: id, avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    recommendation: { deliveryId: `delivery-${id}` } as ShowcaseFeedItem['recommendation'],
    ...overrides,
  };
}

function page(items: ShowcaseFeedItem[], nextCursor: string | null, feedSessionId = 'session-1'): ShowcaseFeedResponse {
  return {
    items,
    feedSessionId,
    algorithmVersion: 'v4',
    nextCursor,
    pageInfo: { hasMore: Boolean(nextCursor), nextCursor },
  };
}

function stubApi(overrides: Partial<Record<'getShowcaseFeed' | 'getShowcasePost', unknown>> = {}) {
  return {
    getShowcaseFeed: vi.fn(async () => page([], null)),
    getShowcasePost: vi.fn(),
    ...overrides,
  } as unknown as LaneProps['api'] & Record<'getShowcaseFeed' | 'getShowcasePost', ReturnType<typeof vi.fn>>;
}

/** The grid's cache as Explore leaves it: its lane's pages, an `updatedAt` ago, under the viewer's identity. */
function gridCache(pages: ShowcaseFeedResponse[], ageMs = 0, filters = FREE_LANE, identityUserId = 'user-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(
    createShowcaseFeedQueryKey(filters, identityUserId),
    { pages, pageParams: pages.map((_, index) => (index === 0 ? { offset: 0 } : { cursor: `cursor-${index + 1}`, feedSessionId: 'session-1' })) },
    { updatedAt: Date.now() - ageMs }
  );
  return client;
}

const trees: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  renderer.act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  auth.user = { id: 'user-1' };
  resetAnonymousShowcaseFeedRemovalsForTests();
});

async function renderLane(props: Omit<LaneProps, 'userId' | 'lane'> & { client?: QueryClient; laneParam?: string; userId?: string }) {
  const { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), laneParam = serializeShowcaseFeedLane(FREE_LANE), userId = 'user-1', ...rest } = props;
  const latest: { current: LaneResult | null } = { current: null };
  // The route hands the reel the lane as a string; the reel parses it back.
  const lane = parseShowcaseFeedLane(laneParam);

  function Probe() {
    latest.current = useShowcaseLaneSource({ ...rest, lane, userId });
    return null;
  }

  await renderer.act(async () => {
    trees.push(renderer.create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  });

  return {
    client,
    latest,
    async until(predicate: (result: LaneResult) => boolean) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latest.current && predicate(latest.current)) return latest.current;
        await renderer.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error(`The lane never reached the expected state: ${JSON.stringify({
        selection: latest.current?.selection,
        ids: latest.current?.items.map((item) => item.id),
      })}`);
    },
  };
}

describe('useShowcaseLaneSource', () => {
  it("opens on the grid's own pages, in the grid's order, and asks for no session of its own", async () => {
    // Ten minutes old: the reel's old loader would have asked for a new For You
    // session on open, and again as the app came back to the foreground.
    const client = gridCache([page([post('first'), post('tapped'), post('third')], 'cursor-2')], 10 * 60 * 1000);
    const api = stubApi();
    const lane = await renderLane({ api, client, initialId: 'tapped' });
    const ready = await lane.until((result) => result.selection === 'found');

    expect(ready.items.map((item) => item.id)).toEqual(['first', 'tapped', 'third']);
    expect(ready.feedSessionId).toBe('session-1');
    expect(ready.items[1].recommendation?.deliveryId).toBe('delivery-tapped');

    await renderer.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await lane.until((result) => result.items.length === 3);
    expect(api.getShowcaseFeed).not.toHaveBeenCalled();
    expect(api.getShowcasePost).not.toHaveBeenCalled();
    focusManager.setFocused(undefined);
  });

  it("pages on through the lane's cursor and session, to the lane's end", async () => {
    const client = gridCache([page([post('first'), post('tapped')], 'cursor-2')]);
    const api = stubApi({ getShowcaseFeed: vi.fn(async () => page([post('next')], null)) });
    const lane = await renderLane({ api, client, initialId: 'tapped' });
    const ready = await lane.until((result) => result.selection === 'found');
    expect(ready.hasNextPage).toBe(true);

    await renderer.act(async () => { lane.latest.current!.fetchNextPage(); });
    const paged = await lane.until((result) => result.items.length === 3 && !result.isFetchingNextPage);

    expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
    expect(api.getShowcaseFeed).toHaveBeenCalledWith({
      limit: 12,
      sort: 'for-you',
      cursor: 'cursor-2',
      feedSessionId: 'session-1',
      category: 'media',
      unlock: 'free',
    });
    expect(paged.items.map((item) => item.id)).toEqual(['first', 'tapped', 'next']);
    // The grid behind the reel holds the same pages: one lane, one cursor.
    expect(lane.client.getQueryData<{ pages: unknown[] }>(createShowcaseFeedQueryKey(FREE_LANE, 'user-1'))?.pages).toHaveLength(2);
    expect(paged.hasNextPage).toBe(false);
    expect(getReelEndSlideState({ ...paged, itemCount: paged.items.length })).toBe('end');

    // At the end there is nothing more to ask for.
    await renderer.act(async () => { lane.latest.current!.fetchNextPage(); });
    expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed page to the closing slide to retry, rather than asking again by itself', async () => {
    const client = gridCache([page([post('tapped')], 'cursor-2')]);
    const api = stubApi({ getShowcaseFeed: vi.fn()
      .mockRejectedValueOnce(new ApiError('Network request failed', 0))
      .mockResolvedValue(page([post('next')], null)) });
    const lane = await renderLane({ api, client, initialId: 'tapped' });
    await lane.until((result) => result.selection === 'found');

    await renderer.act(async () => { lane.latest.current!.fetchNextPage(); });
    const failed = await lane.until((result) => result.isFetchNextPageError && !result.isFetchingNextPage);
    expect(getReelEndSlideState({ ...failed, itemCount: failed.items.length })).toBe('error');

    await renderer.act(async () => { lane.latest.current!.fetchNextPage(); });
    expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);

    await renderer.act(async () => { lane.latest.current!.retryNextPage(); });
    const recovered = await lane.until((result) => result.items.length === 2 && !result.isFetchNextPageError);
    expect(recovered.items.map((item) => item.id)).toEqual(['tapped', 'next']);
    expect(api.getShowcaseFeed).toHaveBeenCalledTimes(2);
  });

  it("looks the opened post up when the lane's pages do not hold it, and keeps it first for the visit", async () => {
    // Sign-in brings the reader back to the lane of another account, whose
    // first page need not hold the post they were on.
    const client = gridCache([page([post('first'), post('second')], 'cursor-2')]);
    const api = stubApi({
      getShowcasePost: vi.fn(async () => ({ success: true, item: post('older') })),
      getShowcaseFeed: vi.fn(async () => page([post('third'), post('older')], null)),
    });
    const lane = await renderLane({ api, client, initialId: 'older' });
    const found = await lane.until((result) => result.selection === 'found');

    expect(api.getShowcasePost).toHaveBeenCalledWith('older');
    expect(found.items.map((item) => item.id)).toEqual(['older', 'first', 'second']);

    // A later page that brings it in does not move it, or list it twice.
    await renderer.act(async () => { lane.latest.current!.fetchNextPage(); });
    const paged = await lane.until((result) => result.items.length === 4);
    expect(paged.items.map((item) => item.id)).toEqual(['older', 'first', 'second', 'third']);
  });

  it('calls the opened post gone only when the server says so', async () => {
    const missingApi = stubApi({ getShowcasePost: vi.fn(async () => { throw new ApiError('Post not found.', 404); }) });
    const missing = await renderLane({ api: missingApi, client: gridCache([page([post('first')], null)]), initialId: 'deleted' });
    expect((await missing.until((result) => result.selection !== 'loading')).selection).toBe('missing');

    const offlineApi = stubApi({ getShowcasePost: vi.fn(async () => { throw new ApiError('Network request failed', 0); }) });
    const offline = await renderLane({ api: offlineApi, client: gridCache([page([post('first')], null)]), initialId: 'deleted' });
    const failed = await offline.until((result) => result.selection !== 'loading');
    expect(failed.selection).toBe('error');

    offlineApi.getShowcasePost.mockResolvedValue({ success: true, item: post('deleted') });
    await renderer.act(async () => { await failed.retrySelection(); });
    expect((await offline.until((result) => result.selection === 'found')).items[0].id).toBe('deleted');
  });

  it("loads the lane's first page when nothing is cached for it", async () => {
    const api = stubApi({ getShowcaseFeed: vi.fn(async () => page([post('tapped')], null)) });
    const lane = await renderLane({ api, initialId: 'tapped', laneParam: serializeShowcaseFeedLane({ sort: 'recent' }) });
    const ready = await lane.until((result) => result.selection === 'found');

    expect(api.getShowcaseFeed).toHaveBeenCalledWith({ limit: 12, sort: 'recent', offset: 0 });
    expect(ready.items.map((item) => item.id)).toEqual(['tapped']);
  });

  // Audit 04-3: the grids key a guest's lane by the guest's own uid.
  it("reads a guest's own lane, without what the guest removed for this visit, as the grid does", async () => {
    auth.user = null;
    rememberAnonymousShowcaseFeedRemoval({ postId: 'hidden' });
    const pages = [page([post('first'), post('hidden'), post('tapped')], null)];
    const api = stubApi();
    const guest = await renderLane({ api, client: gridCache(pages, 0, FREE_LANE, 'guest-1'), initialId: 'tapped', userId: 'guest-1' });
    const ready = await guest.until((result) => result.selection === 'found');

    expect(ready.items.map((item) => item.id)).toEqual(['first', 'tapped']);
    expect(ready.feedSessionId).toBe('session-1');
    expect(api.getShowcaseFeed).not.toHaveBeenCalled();

    // A registered account's removals are kept by the server, not for the visit.
    auth.user = { id: 'user-1' };
    const registered = await renderLane({ api, client: gridCache(pages), initialId: 'tapped' });
    expect((await registered.until((result) => result.selection === 'found')).items.map((item) => item.id))
      .toEqual(['first', 'hidden', 'tapped']);
  });

  it('keeps an Explore reel to the posts with something to show, as its grid does', async () => {
    const client = gridCache([page([post('picture'), post('words', { mediaUrl: null, mediaKind: null, category: 'text', postFormat: 'text' })], null)]);
    const lane = await renderLane({ api: stubApi(), client, initialId: 'picture', mediaOnly: true });
    expect((await lane.until((result) => result.selection === 'found')).items.map((item) => item.id)).toEqual(['picture']);
  });

  it('reads nothing for a reel that was not opened from a lane', async () => {
    const api = stubApi();
    const lane = await renderLane({ api, client: gridCache([page([post('tapped')], null)]), initialId: 'tapped', laneParam: '' });
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(lane.latest.current?.items).toEqual([]);
    expect(lane.latest.current?.selection).toBe('none');
    expect(api.getShowcaseFeed).not.toHaveBeenCalled();
    // And builds that lane exactly as the grid does: same key, same next page.
    expect(showcaseFeedLaneQueryOptions(api, FREE_LANE, 'user-1').queryKey).toEqual(createShowcaseFeedQueryKey(FREE_LANE, 'user-1'));
  });
});
