(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider, focusManager, type InfiniteData } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import { setCachedCreatorProfileBlocked } from '../lib/creator-profile-view-model';
import { getReelEndSlideState } from '../lib/showcase-feed-lane';
import type { CreatorProfileResponse, ShowcaseFeedItem } from '../lib/types';
import {
  CREATOR_PROFILE_PAGE_SIZE,
  creatorProfileGridQueryKey,
  creatorProfileGridQueryOptions,
  removeFromCachedCreatorGrid,
  updateCachedCreatorGridPost,
  useCreatorReelSource,
} from '../lib/use-creator-reel-source';

type ReelProps = Parameters<typeof useCreatorReelSource>[0];
type ReelResult = ReturnType<typeof useCreatorReelSource>;

const LUNA = { id: 'creator-luna', username: 'luna' };
const NOVA = { id: 'creator-nova', username: 'nova' };

function post(id: string, creator = LUNA, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
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
    creator: { id: creator.id, username: creator.username, name: creator.username, avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

/** A page of a creator's grid as the server answers it: stats on the first page only. */
function creatorPage(items: ShowcaseFeedItem[], { offset = 0, hasMore = false, creator = LUNA } = {}): CreatorProfileResponse {
  return {
    profile: {
      id: creator.id,
      username: creator.username,
      displayName: creator.username,
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    },
    ...(offset === 0 ? { stats: { publicCreations: 0, totalSaves: 0, totalRemixes: 0, unlocks: 0, totalUnlockSales: 0, toolsUsed: [] } } : {}),
    items,
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + CREATOR_PROFILE_PAGE_SIZE : null,
      nextLimit: hasMore ? offset + CREATOR_PROFILE_PAGE_SIZE * 2 : null,
      limit: CREATOR_PROFILE_PAGE_SIZE,
      offset,
    },
    viewer: { isOwner: false, isFollowing: true, blockedByViewer: false },
  };
}

function stubApi(overrides: Partial<Record<'getCreatorProfile' | 'getShowcasePost', unknown>> = {}) {
  return {
    getCreatorProfile: vi.fn(async () => creatorPage([])),
    getShowcasePost: vi.fn(),
    ...overrides,
  } as unknown as ReelProps['api'] & Record<'getCreatorProfile' | 'getShowcasePost', ReturnType<typeof vi.fn>>;
}

/** The page's grid as `creator-profile-screen` leaves it: its pages, an `updatedAt` ago. */
function gridCache(pages: CreatorProfileResponse[], ageMs = 0, username = 'luna', client = newClient()) {
  client.setQueryData(
    creatorProfileGridQueryKey(username),
    { pages, pageParams: pages.map((page) => page.pageInfo.offset) },
    { updatedAt: Date.now() - ageMs }
  );
  return client;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function gridIds(client: QueryClient, username = 'luna') {
  return client.getQueryData<InfiniteData<CreatorProfileResponse>>(creatorProfileGridQueryKey(username))?.pages
    .map((page) => page.items.map((item) => item.id));
}

const trees: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  renderer.act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
});

async function renderReel(props: Omit<ReelProps, 'username' | 'viewerUserId'> & {
  client?: QueryClient;
  username?: string | null;
  viewerUserId?: string | null;
}) {
  const { client = newClient(), username = 'luna', viewerUserId = 'viewer-1', ...rest } = props;
  const latest: { current: ReelResult | null } = { current: null };

  function Probe() {
    latest.current = useCreatorReelSource({ ...rest, username, viewerUserId });
    return null;
  }

  await renderer.act(async () => {
    trees.push(renderer.create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  });

  return {
    client,
    latest,
    async until(predicate: (result: ReelResult) => boolean) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latest.current && predicate(latest.current)) return latest.current;
        await renderer.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error(`The reel never reached the expected state: ${JSON.stringify({
        selection: latest.current?.selection,
        ids: latest.current?.items.map((item) => item.id),
      })}`);
    },
  };
}

describe('useCreatorReelSource', () => {
  // Audit 02-6: the reel loaded a window of its own, a new read of 48 posts
  // whenever the grid was older than 45 seconds, and stopped at its end.
  it("opens on the page's own grid, in the grid's order, and reads none of it again", async () => {
    const client = gridCache([creatorPage([post('first'), post('tapped'), post('third')], { hasMore: true })], 10 * 60 * 1000);
    // Another creator's grid, fresher, is not merged in (audit 03-11).
    gridCache([creatorPage([post('nova-post', NOVA)], { creator: NOVA })], 0, 'nova', client);
    const api = stubApi();
    const reel = await renderReel({ api, client, initialId: 'tapped' });
    const ready = await reel.until((result) => result.selection === 'found');

    expect(ready.items.map((item) => item.id)).toEqual(['first', 'tapped', 'third']);
    expect(ready.items.every((item) => item.source === 'creator-profile')).toBe(true);
    expect(ready.creatorId).toBe('creator-luna');
    expect(ready.hasNextPage).toBe(true);

    await renderer.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await reel.until((result) => result.items.length === 3);
    expect(api.getCreatorProfile).not.toHaveBeenCalled();
    expect(api.getShowcasePost).not.toHaveBeenCalled();
    focusManager.setFocused(undefined);
  });

  it("pages on through the grid's offsets, as the page asks for them, to the grid's end", async () => {
    const client = gridCache([creatorPage([post('first'), post('tapped')], { hasMore: true })]);
    const api = stubApi({
      getCreatorProfile: vi.fn(async () => creatorPage([post('next')], { offset: CREATOR_PROFILE_PAGE_SIZE })),
    });
    const reel = await renderReel({ api, client, initialId: 'tapped' });
    await reel.until((result) => result.selection === 'found');

    await renderer.act(async () => { reel.latest.current!.fetchNextPage(); });
    const paged = await reel.until((result) => result.items.length === 3 && !result.isFetchingNextPage);

    expect(api.getCreatorProfile.mock.calls).toEqual([['luna', { limit: 24, offset: 24 }]]);
    expect(paged.items.map((item) => item.id)).toEqual(['first', 'tapped', 'next']);
    // The grid under the reel holds the same pages: one creator, one set of offsets.
    expect(gridIds(client)).toEqual([['first', 'tapped'], ['next']]);
    expect(paged.hasNextPage).toBe(false);
    expect(getReelEndSlideState({ ...paged, itemCount: paged.items.length })).toBe('end');

    // At the end there is nothing more to ask for.
    await renderer.act(async () => { reel.latest.current!.fetchNextPage(); });
    expect(api.getCreatorProfile).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed page to the closing slide to retry, rather than asking again by itself', async () => {
    const client = gridCache([creatorPage([post('tapped')], { hasMore: true })]);
    const api = stubApi({ getCreatorProfile: vi.fn()
      .mockRejectedValueOnce(new ApiError('Network request failed', 0))
      .mockResolvedValue(creatorPage([post('next')], { offset: CREATOR_PROFILE_PAGE_SIZE })) });
    const reel = await renderReel({ api, client, initialId: 'tapped' });
    await reel.until((result) => result.selection === 'found');

    await renderer.act(async () => { reel.latest.current!.fetchNextPage(); });
    const failed = await reel.until((result) => result.isFetchNextPageError && !result.isFetchingNextPage);
    expect(getReelEndSlideState({ ...failed, itemCount: failed.items.length })).toBe('error');
    // A failed next page is not a failed reel: the posts it has stay.
    expect(failed.isError).toBe(false);

    await renderer.act(async () => { reel.latest.current!.fetchNextPage(); });
    expect(api.getCreatorProfile).toHaveBeenCalledTimes(1);

    await renderer.act(async () => { reel.latest.current!.retryNextPage(); });
    const recovered = await reel.until((result) => result.items.length === 2 && !result.isFetchNextPageError);
    expect(recovered.items.map((item) => item.id)).toEqual(['tapped', 'next']);
    expect(api.getCreatorProfile).toHaveBeenCalledTimes(2);
  });

  it("loads the grid's first page, as the page would, when nothing is cached for it", async () => {
    const api = stubApi({ getCreatorProfile: vi.fn(async () => creatorPage([post('tapped')])) });
    const reel = await renderReel({ api, initialId: 'tapped' });
    const ready = await reel.until((result) => result.selection === 'found');

    expect(api.getCreatorProfile.mock.calls).toEqual([['luna', { limit: 24, offset: 0 }]]);
    expect(ready.items.map((item) => item.id)).toEqual(['tapped']);
  });

  it("looks the opened post up when the grid's pages do not hold it, and keeps it first for the visit", async () => {
    const client = gridCache([creatorPage([post('first'), post('second')], { hasMore: true })]);
    const api = stubApi({
      getShowcasePost: vi.fn(async () => ({ success: true, item: post('older') })),
      getCreatorProfile: vi.fn(async () => creatorPage([post('third'), post('older')], { offset: CREATOR_PROFILE_PAGE_SIZE })),
    });
    const reel = await renderReel({ api, client, initialId: 'older' });
    const found = await reel.until((result) => result.selection === 'found');

    expect(api.getShowcasePost).toHaveBeenCalledWith('older');
    expect(found.items.map((item) => item.id)).toEqual(['older', 'first', 'second']);

    // A later page that brings it in does not move it, or list it twice.
    await renderer.act(async () => { reel.latest.current!.fetchNextPage(); });
    const paged = await reel.until((result) => result.items.length === 4);
    expect(paged.items.map((item) => item.id)).toEqual(['older', 'first', 'second', 'third']);
  });

  it('does not look a post up again once the reader took it out of the grid', async () => {
    const client = gridCache([creatorPage([post('a'), post('b'), post('c')])]);
    const api = stubApi({ getShowcasePost: vi.fn(async () => ({ success: true, item: post('b') })) });
    const reel = await renderReel({ api, client, initialId: 'b' });
    await reel.until((result) => result.selection === 'found');

    await renderer.act(async () => {
      removeFromCachedCreatorGrid(client, 'luna', { postId: 'b' });
    });
    const removed = await reel.until((result) => result.items.length === 2);

    expect(removed.items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(removed.selection).toBe('none');
    expect(api.getShowcasePost).not.toHaveBeenCalled();
  });

  it('calls the opened post gone only when the server says so', async () => {
    const missingApi = stubApi({ getShowcasePost: vi.fn(async () => { throw new ApiError('Post not found.', 404); }) });
    const missing = await renderReel({ api: missingApi, client: gridCache([creatorPage([post('first')])]), initialId: 'deleted' });
    expect((await missing.until((result) => result.selection !== 'loading')).selection).toBe('missing');

    const offlineApi = stubApi({ getShowcasePost: vi.fn(async () => { throw new ApiError('Network request failed', 0); }) });
    const offline = await renderReel({ api: offlineApi, client: gridCache([creatorPage([post('first')])]), initialId: 'deleted' });
    const failed = await offline.until((result) => result.selection !== 'loading');
    expect(failed.selection).toBe('error');

    offlineApi.getShowcasePost.mockResolvedValue({ success: true, item: post('deleted') });
    await renderer.act(async () => { await failed.retrySelection(); });
    expect((await offline.until((result) => result.selection === 'found')).items[0].id).toBe('deleted');
  });

  // The page's Block and the reel's write the server's answer for a blocked
  // creator into the grid (`setCachedCreatorProfileBlocked`): no posts.
  it('holds nothing once the creator is blocked, and looks nothing up', async () => {
    const client = gridCache([creatorPage([post('a'), post('b')], { hasMore: true })]);
    const api = stubApi();
    const reel = await renderReel({ api, client, initialId: 'b' });
    await reel.until((result) => result.selection === 'found');

    await renderer.act(async () => { setCachedCreatorProfileBlocked(client, 'creator-luna'); });
    const blocked = await reel.until((result) => result.items.length === 0);

    expect(blocked.selection).toBe('none');
    expect(blocked.hasNextPage).toBe(false);
    expect(blocked.creatorId).toBe('creator-luna');
    expect(api.getShowcasePost).not.toHaveBeenCalled();
    expect(api.getCreatorProfile).not.toHaveBeenCalled();
  });

  it('keeps a reel to the posts with something to show when the route asks', async () => {
    const client = gridCache([creatorPage([post('picture'), post('words', LUNA, { mediaUrl: null, mediaKind: null, category: 'text', postFormat: 'text' })])]);
    const reel = await renderReel({ api: stubApi(), client, initialId: 'picture', mediaOnly: true });
    expect((await reel.until((result) => result.selection === 'found')).items.map((item) => item.id)).toEqual(['picture']);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('keeps its pinned post and reads nothing again after every effect runs again', async () => {
    const client = gridCache([creatorPage([post('first'), post('second')], { hasMore: true })]);
    const api = stubApi({ getShowcasePost: vi.fn(async () => ({ success: true, item: post('older') })) });
    const latest: { current: ReelResult | null } = { current: null };
    function Probe() {
      latest.current = useCreatorReelSource({ api, username: 'luna', initialId: 'older', viewerUserId: 'viewer-1' });
      return null;
    }
    const inActivity = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <React.Activity mode={mode}><Probe /></React.Activity>
      </QueryClientProvider>
    );
    const settle = () => renderer.act(async () => {
      for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
    trees.push(tree);
    await settle();
    expect(latest.current?.items.map((item) => item.id)).toEqual(['older', 'first', 'second']);

    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    await settle();

    expect(latest.current?.selection).toBe('found');
    expect(latest.current?.items.map((item) => item.id)).toEqual(['older', 'first', 'second']);
    expect(api.getShowcasePost).toHaveBeenCalledTimes(1);
    expect(api.getCreatorProfile).not.toHaveBeenCalled();
  });

  it("reads nothing for a reel that was not opened on a creator's page", async () => {
    const client = gridCache([creatorPage([post('tapped')])]);
    const api = stubApi();
    const disabled = await renderReel({ api, client, initialId: 'tapped', enabled: false });
    const unnamed = await renderReel({ api, client, initialId: 'tapped', username: null });
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    for (const reel of [disabled, unnamed]) {
      expect(reel.latest.current?.items).toEqual([]);
      expect(reel.latest.current?.selection).toBe('none');
      expect(reel.latest.current?.isLoading).toBe(false);
    }
    expect(api.getCreatorProfile).not.toHaveBeenCalled();
    expect(api.getShowcasePost).not.toHaveBeenCalled();
  });
});

describe("the creator page's grid query", () => {
  it('is the one key and page size the page reads', () => {
    const options = creatorProfileGridQueryOptions(stubApi(), 'luna');
    expect(options.queryKey).toEqual(['creator-profile', 'infinite', 'luna']);
    expect(options.initialPageParam).toBe(0);
    expect(CREATOR_PROFILE_PAGE_SIZE).toBe(24);
  });

  // The page builds the same query in place (WP10's file). A reel paging the
  // grid with another page size would leave a gap when either refetches it.
  it('asks for the very pages the creator page asks for', () => {
    const screen = readFileSync('components/creator-profile-screen.tsx', 'utf8');
    if (screen.includes('creatorProfileGridQueryOptions(api, username)')) return;
    expect(screen).toContain("['creator-profile', 'infinite', username]");
    expect(screen).toContain(`const PROFILE_PAGE_SIZE = ${CREATOR_PROFILE_PAGE_SIZE};`);
    expect(screen).toMatch(/initialPageParam: 0,\s+queryFn: \(\{ pageParam \}\) => api\.getCreatorProfile\(username, \{\s+limit: PROFILE_PAGE_SIZE,\s+offset: pageParam,\s+\}\),\s+getNextPageParam: getNextCreatorProfileOffset,/);
  });
});

describe("a reel's changes to a creator's grid", () => {
  it('writes a post into the grid that holds it, and leaves every other grid as it was', () => {
    const client = gridCache([creatorPage([post('a')], { hasMore: true }), creatorPage([post('b')], { offset: 24 })]);
    gridCache([creatorPage([post('n1', NOVA)], { creator: NOVA })], 5000, 'nova', client);
    const novaBefore = client.getQueryData(creatorProfileGridQueryKey('nova'));
    const novaUpdatedAt = client.getQueryState(creatorProfileGridQueryKey('nova'))?.dataUpdatedAt;

    updateCachedCreatorGridPost(client, 'b', (item) => ({ ...item, isSaved: true, saveCount: 4 }));

    const luna = client.getQueryData<InfiniteData<CreatorProfileResponse>>(creatorProfileGridQueryKey('luna'))!;
    expect(luna.pages[1].items[0]).toMatchObject({ id: 'b', isSaved: true, saveCount: 4 });
    expect(luna.pages[0].items[0].isSaved).toBeUndefined();
    // Each page is still the creator's page: header, counts and viewer state.
    expect(luna.pages[0].profile.id).toBe('creator-luna');
    expect(luna.pages[0].stats).toBeDefined();
    expect(luna.pages[1].viewer.isFollowing).toBe(true);
    expect(client.getQueryData(creatorProfileGridQueryKey('nova'))).toBe(novaBefore);
    expect(client.getQueryState(creatorProfileGridQueryKey('nova'))?.dataUpdatedAt).toBe(novaUpdatedAt);
  });

  it('takes a post out of the grid, and puts it back at its index', () => {
    const client = gridCache([creatorPage([post('a'), post('b'), post('c')], { hasMore: true }), creatorPage([post('d')], { offset: 24 })]);

    const restore = removeFromCachedCreatorGrid(client, 'luna', { postId: 'b' });
    expect(gridIds(client)).toEqual([['a', 'c'], ['d']]);

    // A page that landed since stays.
    client.setQueryData<InfiniteData<CreatorProfileResponse>>(creatorProfileGridQueryKey('luna'), (data) => data && {
      pages: [...data.pages, creatorPage([post('e')], { offset: 48 })],
      pageParams: [...data.pageParams, 48],
    });
    restore();
    expect(gridIds(client)).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
    const first = client.getQueryData<InfiniteData<CreatorProfileResponse>>(creatorProfileGridQueryKey('luna'))!.pages[0];
    expect(first.profile.id).toBe('creator-luna');
    expect(first.pageInfo.hasMore).toBe(true);

    // Run again, it puts nothing back twice.
    restore();
    expect(gridIds(client)).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
  });

  it('writes nothing to a grid that never held the post', () => {
    const client = gridCache([creatorPage([post('a')])], 5000);
    const before = client.getQueryData(creatorProfileGridQueryKey('luna'));

    const restore = removeFromCachedCreatorGrid(client, 'luna', { postId: 'elsewhere' });
    updateCachedCreatorGridPost(client, 'elsewhere', (item) => ({ ...item, commentCount: 3 }));
    restore();

    expect(client.getQueryData(creatorProfileGridQueryKey('luna'))).toBe(before);
    expect(removeFromCachedCreatorGrid(client, 'nobody', { postId: 'a' })).toEqual(expect.any(Function));
  });
});
