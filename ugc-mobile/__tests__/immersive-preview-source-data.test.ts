import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import {
  buildViewerItems,
  isLinkedPostAlone,
  keepReelPagePosts,
  linkReelEndSlideState,
  loadImmersiveSourceData,
  loadShowcaseReelNeighbours,
  readCachedImmersiveSourceData,
  readCachedImmersiveSourceSnapshot,
} from '../lib/immersive-preview-source-data';
import { profileArchivedGenerationsQueryKey, profileFailedGenerationsQueryKey } from '../lib/profile-media-query';
import { createShowcasePostQueryKey, SHOWCASE_FEED_PAGE_SIZE } from '../lib/showcase-feed-query';
import type { CreatorProfileResponse, GenerationListItem, ShowcaseFeedItem } from '../lib/types';

function generation(id: string, overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.jpg`,
    status: 'succeeded',
    created_at: '2026-09-02T10:00:00.000Z',
    completed_at: '2026-09-02T10:01:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: id,
    prompt: 'A prompt.',
    ...overrides,
  };
}

function showcaseItem(id: string): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: 'Creator post',
    prompt: 'Creator prompt',
    body: 'Creator body',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-05-13T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

function creatorProfile(items: ShowcaseFeedItem[]): CreatorProfileResponse {
  return {
    profile: {
      id: 'creator-1',
      username: 'luna',
      displayName: 'Luna',
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    },
    stats: {
      publicCreations: items.length,
      totalSaves: 0,
      totalRemixes: 0,
      unlocks: 0,
      totalUnlockSales: 0,
      toolsUsed: [],
    },
    items,
    pageInfo: {
      hasMore: false,
      nextLimit: null,
      nextOffset: null,
      limit: 48,
      offset: 0,
    },
    viewer: {
      isOwner: false,
      isFollowing: false,
    },
  };
}

describe('immersive preview source data', () => {
  it('retains Explore media filtering when refreshing the reel', async () => {
    const api = { getShowcaseFeed: vi.fn(async () => ({ items: [] })) };
    await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: '', mediaOnly: true });
    expect(api.getShowcaseFeed).toHaveBeenLastCalledWith({ limit: 12, sort: 'for-you', category: 'media' });
    await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: '' });
    expect(api.getShowcaseFeed).toHaveBeenLastCalledWith({ limit: 12, sort: 'for-you' });
  });

  // Every post the page holds is served to the reader, and a post served and
  // never reached counts against it in the ranking. 48 (clamped to 24 by the
  // route) served two dozen posts for a reel opened from a link or a search
  // result (audit 04-10).
  it('asks one page of For You for a reel opened without a lane, as a lane does', async () => {
    const api = {
      getShowcaseFeed: vi.fn(async () => ({ items: [showcaseItem('post-1')], feedSessionId: 'session-1' })),
      getShowcasePost: vi.fn(async () => ({ item: showcaseItem('post-9') })),
    };
    await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: 'post-9' });

    expect(api.getShowcaseFeed).toHaveBeenCalledTimes(1);
    expect(api.getShowcaseFeed.mock.calls[0]).toEqual([{ limit: SHOWCASE_FEED_PAGE_SIZE, sort: 'for-you' }]);
    expect(SHOWCASE_FEED_PAGE_SIZE).toBe(12);
  });

  it('reads the opened post beside the feed and puts it first when the feed lacks it', async () => {
    const opened = showcaseItem('post-9');
    const api = {
      getShowcaseFeed: vi.fn(async () => ({ items: [showcaseItem('post-1')] })),
      getShowcasePost: vi.fn(async () => ({ item: opened })),
    };
    const data = await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: 'post-9' });
    expect(api.getShowcasePost).toHaveBeenCalledWith('post-9');
    expect(data.showcaseItems?.map((item) => item.id)).toEqual(['post-9', 'post-1']);

    // Already in the feed: it is not listed twice.
    api.getShowcaseFeed.mockResolvedValueOnce({ items: [opened] });
    const again = await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: 'post-9' });
    expect(again.showcaseItems?.map((item) => item.id)).toEqual(['post-9']);
  });

  it('calls a post gone only when the server says so, and lets any other failure be retried', async () => {
    const api = {
      getShowcaseFeed: vi.fn(async () => ({ items: [showcaseItem('post-1')] })),
      getSavedMedia: vi.fn(async () => ({ items: [] })),
      getShowcasePost: vi.fn(async (): Promise<never> => { throw new ApiError('Post not found.', 404); }),
    };

    // A 404 loads the window without the post: the reel says it is not available.
    for (const source of ['showcase-feed', 'profile-saved', 'creator-profile'] as const) {
      const data = await loadImmersiveSourceData({ api: api as never, source, initialId: 'post-9' });
      expect(data.showcaseItems?.some((item) => item.id === 'post-9')).toBe(false);
    }

    // A dropped connection used to read the same way, with no way to try again.
    api.getShowcasePost.mockImplementation(async () => { throw new ApiError('Network request failed', 0); });
    for (const source of ['showcase-feed', 'profile-saved', 'creator-profile'] as const) {
      await expect(loadImmersiveSourceData({ api: api as never, source, initialId: 'post-9' }))
        .rejects.toMatchObject({ status: 0 });
    }
  });
  const owner = { creatorLabel: '@creator', creatorAvatar: null, creatorId: 'user-1' };

  it('keeps the reel to the creations the grid shows', () => {
    const items = buildViewerItems('studio-creations', {
      generations: [
        generation('ready'),
        generation('failed', { status: 'failed', output_url: null }),
        generation('rendering', { status: 'processing', output_url: null }),
      ],
    }, owner);

    expect(items.map((item) => item.id)).toEqual(['ready']);
  });

  it('keeps the creation the reader opened, even when it has nothing to play', () => {
    // "Your video failed" deep-links straight to its own run. The notification
    // has to land on the run it names, not on an unrelated creation.
    const items = buildViewerItems('studio-creations', {
      generations: [
        generation('ready'),
        generation('failed', { status: 'failed', output_url: null }),
      ],
    }, owner, 'failed');

    expect(items.map((item) => item.id)).toEqual(['ready', 'failed']);
    expect(items[1].runStatus).toBe('failed');
  });

  it('loads the unarchived library window and leaves owner posts to enrichment', async () => {
    const api = {
      getCreatorProfile: vi.fn(),
      getSavedMedia: vi.fn(),
      getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(),
      getOwnerPost: vi.fn(),
      listGenerations: vi.fn(async () => ({ generations: [] })),
      listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
    };

    await loadImmersiveSourceData({
      api,
      source: 'home-creations',
      initialId: '',
    });

    expect(api.listGenerations).toHaveBeenCalledWith(false, { limit: 48 });
    // Linked-post details load beside the creations, never in front of them.
    expect(api.listOwnerPosts).not.toHaveBeenCalled();
  });

  it('shares one library read between viewers that open at the same time', async () => {
    let finish: (value: { generations: GenerationListItem[] }) => void = () => undefined;
    const api = {
      getCreatorProfile: vi.fn(), getSavedMedia: vi.fn(), getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(), getOwnerPost: vi.fn(), listOwnerPosts: vi.fn(),
      listGenerations: vi.fn(() => new Promise<{ generations: GenerationListItem[] }>((resolve) => { finish = resolve; })),
    };

    const first = loadImmersiveSourceData({ api, source: 'profile-creations', initialId: 'gen-1' });
    const second = loadImmersiveSourceData({ api, source: 'studio-creations', initialId: 'gen-1' });
    finish({ generations: [generation('gen-1')] });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(api.listGenerations).toHaveBeenCalledTimes(1);

    // A settled read is not cached: the next open asks again.
    api.listGenerations.mockImplementationOnce(async () => ({ generations: [generation('gen-1')] }));
    await loadImmersiveSourceData({ api, source: 'profile-creations', initialId: 'gen-1' });
    expect(api.listGenerations).toHaveBeenCalledTimes(2);
  });

  it.each(['profile-creations', 'studio-creations', 'home-creations'] as const)(
    'recovers an older selected creation for %s without loading the whole library', async (source) => {
      const selected = generation('older-generation');
      const recent = Array.from({ length: 48 }, (_, index) => generation(`recent-${index}`));
      const api = {
        getCreatorProfile: vi.fn(), getSavedMedia: vi.fn(), getShowcaseFeed: vi.fn(),
        getShowcasePost: vi.fn(), getOwnerPost: vi.fn(),
        listGenerations: vi.fn(async (_include?: boolean, options?: { id?: string }) => ({
          generations: options?.id ? [selected] : recent,
        })),
        listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
      };
      const data = await loadImmersiveSourceData({ api, source, initialId: selected.id });
      expect(data.generations).toEqual([selected, ...recent]);
      expect(api.listGenerations).toHaveBeenNthCalledWith(2, true, { id: selected.id, limit: 1 });
      expect(api.listGenerations).toHaveBeenCalledTimes(2);
    }
  );

  it('recovers an older owner post using its authenticated detail endpoint', async () => {
    const selected = { id: 'older-post' };
    const recent = [{ id: 'recent-post' }];
    const api = {
      getCreatorProfile: vi.fn(), getSavedMedia: vi.fn(), getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(), listGenerations: vi.fn(),
      getOwnerPost: vi.fn(async () => ({ success: true, post: selected })),
      listOwnerPosts: vi.fn(async () => ({ success: true, posts: recent })),
    };
    const data = await loadImmersiveSourceData({ api: api as never, source: 'profile-posts', initialId: selected.id });
    expect(data.ownerPosts).toEqual([selected, ...recent]);
    expect(api.getOwnerPost).toHaveBeenCalledWith(selected.id);
    expect(api.getShowcasePost).not.toHaveBeenCalled();
  });

  it('does not fetch a detail or duplicate an item already on the first page', async () => {
    const selected = generation('selected');
    const api = {
      getCreatorProfile: vi.fn(), getSavedMedia: vi.fn(), getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(), getOwnerPost: vi.fn(),
      listGenerations: vi.fn(async () => ({ generations: [selected] })),
      listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
    };
    const data = await loadImmersiveSourceData({ api, source: 'profile-creations', initialId: selected.id });
    expect(data.generations).toEqual([selected]);
    expect(api.listGenerations).toHaveBeenCalledTimes(1);
  });

  it('lets a failed detail refresh retain cached data rather than replacing the selected item', async () => {
    const api = {
      getCreatorProfile: vi.fn(), getSavedMedia: vi.fn(), getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(), getOwnerPost: vi.fn(),
      listGenerations: vi.fn()
        .mockResolvedValueOnce({ generations: [generation('recent')] })
        .mockRejectedValueOnce(new Error('Network unavailable')),
      listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
    };
    await expect(loadImmersiveSourceData({ api, source: 'profile-creations', initialId: 'older' }))
      .rejects.toThrow('Network unavailable');
  });

  // A reel opened on a creator's page reads and pages that page's grid
  // (`use-creator-reel-source`). This loader used to read a 48-post window of
  // the creator's own that stopped there (audit 02-6); a link that names no
  // creator now opens on the post alone, and nothing reads the creator's posts.
  it("reads no creator's posts for a creator's reel: the post alone", async () => {
    const item = showcaseItem('post-1');
    const api = {
      getCreatorProfile: vi.fn(async () => creatorProfile([showcaseItem('post-2'), item])),
      getSavedMedia: vi.fn(),
      getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(async () => ({ success: true, item })),
      getOwnerPost: vi.fn(),
      listGenerations: vi.fn(),
      listOwnerPosts: vi.fn(),
    };

    const data = await loadImmersiveSourceData({ api, source: 'creator-profile', initialId: 'post-1' });

    expect(data.showcaseItems).toEqual([item]);
    expect(api.getShowcasePost).toHaveBeenCalledWith('post-1');
    expect(api.getCreatorProfile).not.toHaveBeenCalled();
    expect(api.getShowcaseFeed).not.toHaveBeenCalled();
  });

  it("opens a creator's reel on no other cache, its grid or a lane that holds the post", () => {
    const queryClient = new QueryClient();
    const item = showcaseItem('post-1');
    queryClient.setQueryData(['creator-profile', 'infinite', 'luna'], { pages: [creatorProfile([item])], pageParams: [0] });
    queryClient.setQueryData(['showcase-feed', 'infinite', 'user-1', { sort: 'for-you' }], {
      pages: [{ items: [showcaseItem('post-0'), item], feedSessionId: 'session-1' }],
      pageParams: [{ offset: 0 }],
    });

    expect(readCachedImmersiveSourceData(queryClient, 'creator-profile', 'user-1', 'post-1', null, 'user-1')).toBeUndefined();
    expect(readCachedImmersiveSourceData(queryClient, 'creator-profile', 'user-1', 'post-1')).toBeUndefined();
  });

  it('reads paginated profile caches for viewer launches', () => {
    const queryClient = new QueryClient();
    const first = showcaseItem('post-1');
    const second = showcaseItem('post-2');
    queryClient.setQueryData(['profile-saved-media', 'user-1'], {
      pages: [
        { items: [{ ...first, isSaved: true }] },
        { items: [{ ...second, isSaved: true }] },
      ],
      pageParams: [0, 24],
    });

    expect(readCachedImmersiveSourceData(queryClient, 'profile-saved', 'user-1', 'post-2')).toEqual({
      showcaseItems: [{ ...first, isSaved: true }, { ...second, isSaved: true }],
    });
  });

  it('merges a paginated profile cache with the single-page library cache', () => {
    // profile-generations pages; home-generations does not.
    const queryClient = new QueryClient();
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [
        { generations: [{ id: 'gen-1', output_url: 'a.png' }] },
        { generations: [{ id: 'gen-2', output_url: 'b.png' }] },
      ],
      pageParams: [null, '24'],
    });
    queryClient.setQueryData(['generations', 'user-1'], {
      generations: [{ id: 'gen-2', output_url: 'b.png' }, { id: 'gen-3', output_url: 'c.png' }],
    });

    const data = readCachedImmersiveSourceData(queryClient, 'profile-creations', 'user-1', 'gen-3');
    expect(data?.generations?.map((item) => item.id)).toEqual(['gen-1', 'gen-2', 'gen-3']);
  });

  it('merges paginated owner posts with the single-page sales summary cache', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['profile-owner-posts', 'user-1'], {
      pages: [
        { success: true, posts: [{ id: 'post-a', mediaUrl: 'a.png', mediaKind: 'image' }] },
        { success: true, posts: [{ id: 'post-b', mediaUrl: 'b.png', mediaKind: 'image' }] },
      ],
      pageParams: [0, 24],
    });

    const data = readCachedImmersiveSourceData(queryClient, 'profile-posts', 'user-1', 'post-b');
    expect(data?.ownerPosts?.map((item) => item.id)).toEqual(['post-a', 'post-b']);
  });

  it('preserves the originating ranked feed order and session in the viewer cache', () => {
    const queryClient = new QueryClient();
    const rankedItems = [showcaseItem('post-2'), showcaseItem('post-1'), showcaseItem('post-3')];
    queryClient.setQueryData(['showcase-feed', 'infinite', 'user-1', { sort: 'for-you' }], {
      pages: [{
        items: rankedItems,
        feedSessionId: 'session-1',
        algorithmVersion: 'hybrid-v1',
        nextCursor: null,
      }],
      pageParams: [{ offset: 0 }],
    });

    expect(readCachedImmersiveSourceData(
      queryClient,
      'showcase-feed',
      'user-1',
      'post-1',
      'session-1',
      'user-1'
    )).toEqual({
      showcaseItems: rankedItems,
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
    });
  });

  it('does not reuse the installation ranked session for a signed-in viewer', () => {
    const queryClient = new QueryClient();
    const installationItem = { ...showcaseItem('post-1'), title: 'Installation ranking' };
    const signedInItem = { ...showcaseItem('post-1'), title: 'Signed-in ranking' };
    queryClient.setQueryData(['showcase-feed', 'infinite', 'installation', { sort: 'for-you' }], {
      pages: [{ items: [installationItem], feedSessionId: 'installation-session' }],
      pageParams: [{ offset: 0 }],
    });
    queryClient.setQueryData(['showcase-feed', 'infinite', 'user-1', { sort: 'for-you' }], {
      pages: [{ items: [signedInItem], feedSessionId: 'user-session' }],
      pageParams: [{ offset: 0 }],
    });

    expect(readCachedImmersiveSourceData(
      queryClient,
      'showcase-feed',
      'user-1',
      'post-1',
      null,
      'user-1'
    )).toMatchObject({
      showcaseItems: [{ title: 'Signed-in ranking' }],
      feedSessionId: 'user-session',
    });
  });

  // The grids key a guest's lanes by the guest's identity (audit 04-3), and a
  // guest has no registered id at all: a lookup by that id read the
  // installation's lane, whose session the server refuses for the guest.
  it("opens a guest's reel on the guest's own lane, not the installation's", () => {
    const queryClient = new QueryClient();
    const installationItem = { ...showcaseItem('post-1'), title: 'Installation ranking' };
    const guestItem = { ...showcaseItem('post-1'), title: 'Guest ranking' };
    queryClient.setQueryData(['showcase-feed', 'infinite', 'installation', { sort: 'for-you' }], {
      pages: [{ items: [installationItem], feedSessionId: 'installation-session' }],
      pageParams: [{ offset: 0 }],
    });
    queryClient.setQueryData(['showcase-feed', 'infinite', 'guest-1', { sort: 'for-you' }], {
      pages: [{ items: [guestItem], feedSessionId: 'guest-session' }],
      pageParams: [{ offset: 0 }],
    });

    expect(readCachedImmersiveSourceSnapshot(
      queryClient,
      'showcase-feed',
      undefined,
      'post-1',
      null,
      'guest-1'
    )?.data).toMatchObject({
      showcaseItems: [{ title: 'Guest ranking' }],
      feedSessionId: 'guest-session',
    });
    // A device with no identity yet reads the installation's lane.
    expect(readCachedImmersiveSourceData(queryClient, 'showcase-feed', undefined, 'post-1', null, null))
      .toMatchObject({ feedSessionId: 'installation-session' });
  });

  it('keeps the newest copy of a creation found in two caches, and the older cache\'s age', () => {
    const queryClient = new QueryClient();
    const now = Date.now();
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [{ generations: [generation('gen-1', { title: 'Old title' }), generation('gen-2')] }],
      pageParams: [null],
    }, { updatedAt: now - 60 * 60 * 1000 });
    queryClient.setQueryData(['generations', 'user-1'], {
      generations: [generation('gen-1', { title: 'Renamed a minute ago' })],
    }, { updatedAt: now - 60 * 1000 });

    const snapshot = readCachedImmersiveSourceSnapshot(queryClient, 'home-creations', 'user-1', 'gen-1');

    // Order still follows the caches' precedence; the version follows freshness.
    expect(snapshot?.data.generations?.map((item) => [item.id, item.title])).toEqual([
      ['gen-1', 'Renamed a minute ago'],
      ['gen-2', 'gen-2'],
    ]);
    // A snapshot is only as fresh as its stalest part.
    expect(snapshot?.updatedAt).toBe(now - 60 * 60 * 1000);
  });

  it('does not hand a viewer a snapshot that lacks the item it opened', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['generations', 'user-1'], { generations: [generation('gen-1')] });

    expect(readCachedImmersiveSourceSnapshot(queryClient, 'home-creations', 'user-1', 'elsewhere')).toBeUndefined();
  });

  // A shared link, a push or a deep link reaches the reel through the post
  // page (`app/post/[id].tsx`), which has just read the post: the reel used to
  // read it again, beside a For you page, before it drew anything.
  it("opens a reel a link opened on the post page's own read of the post, with its age", () => {
    const queryClient = new QueryClient();
    const readAt = Date.now() - 5_000;
    const opened = showcaseItem('post-9');
    queryClient.setQueryData(createShowcasePostQueryKey('post-9', 'user-1'), { success: true, item: opened }, { updatedAt: readAt });
    // A saved page that lacks it is no snapshot of it.
    queryClient.setQueryData(['profile-saved-media', 'user-1'], { pages: [{ items: [showcaseItem('post-1')] }], pageParams: [0] });

    const snapshot = readCachedImmersiveSourceSnapshot(queryClient, 'showcase-feed', 'user-1', 'post-9', null, 'user-1');
    expect(snapshot).toEqual({ data: { showcaseItems: [opened] }, updatedAt: readAt });
    // Another account's read is not this one's; nor is another post's.
    expect(readCachedImmersiveSourceSnapshot(queryClient, 'showcase-feed', 'user-2', 'post-9', null, 'user-2')).toBeUndefined();
    expect(readCachedImmersiveSourceSnapshot(queryClient, 'showcase-feed', 'user-1', 'post-8', null, 'user-1')).toBeUndefined();
  });

  // Review of #919: Home seeds the post's read with its own feed card before it
  // opens a post; a link opened later must not file this reel's events against
  // Home's delivery.
  it("takes the post page's read without the delivery a Home card left on it", () => {
    const queryClient = new QueryClient();
    const card = { ...showcaseItem('post-9'), recommendation: { deliveryId: 'home-delivery', position: 3, algorithmVersion: 'v4' } } as ShowcaseFeedItem;
    queryClient.setQueryData(createShowcasePostQueryKey('post-9', 'user-1'), { success: true, item: card });

    const item = readCachedImmersiveSourceData(queryClient, 'showcase-feed', 'user-1', 'post-9', null, 'user-1')?.showcaseItems?.[0];
    expect(item?.id).toBe('post-9');
    expect(item && 'recommendation' in item).toBe(false);
    // The cache's own copy is left as it was.
    expect(queryClient.getQueryData<{ item: ShowcaseFeedItem }>(createShowcasePostQueryKey('post-9', 'user-1'))?.item.recommendation?.deliveryId).toBe('home-delivery');
  });

  it('calls a For you reel the linked post alone only while it holds that post and no page read', () => {
    expect(isLinkedPostAlone(undefined)).toBe(true);
    expect(isLinkedPostAlone({ showcaseItems: [] })).toBe(true);
    expect(isLinkedPostAlone({ showcaseItems: [showcaseItem('post-9')] })).toBe(true);
    // A page was read with it, even an empty one or one with no session.
    expect(isLinkedPostAlone({ showcaseItems: [showcaseItem('post-9')], feedSessionId: null })).toBe(false);
    // A whole list: the saved pages holding the post, or a list kept from before.
    expect(isLinkedPostAlone({ showcaseItems: [showcaseItem('post-1'), showcaseItem('post-9')] })).toBe(false);
  });

  it('keeps a lane that holds the post ahead of the post page\'s read', () => {
    const queryClient = new QueryClient();
    const rankedItems = [showcaseItem('post-2'), showcaseItem('post-9')];
    queryClient.setQueryData(['showcase-feed', 'infinite', 'user-1', { sort: 'for-you' }], {
      pages: [{ items: rankedItems, feedSessionId: 'session-1', algorithmVersion: 'hybrid-v1', nextCursor: null }],
      pageParams: [{ offset: 0 }],
    });
    queryClient.setQueryData(createShowcasePostQueryKey('post-9', 'user-1'), { success: true, item: showcaseItem('post-9') });

    expect(readCachedImmersiveSourceData(queryClient, 'showcase-feed', 'user-1', 'post-9', null, 'user-1')).toMatchObject({
      showcaseItems: rankedItems,
      feedSessionId: 'session-1',
    });
  });

  // Every post a For you page holds is served to the reader, and a post served
  // and never seen ranks lower for them for hours (`served_penalty`): a link
  // opened, read and left serves nothing.
  it('reads the post alone for a reel a link opened, until its neighbours are asked for', async () => {
    const api = {
      getShowcaseFeed: vi.fn(async () => ({ items: [showcaseItem('post-1')], feedSessionId: 'session-1' })),
      getShowcasePost: vi.fn(async () => ({ item: showcaseItem('post-9') })),
    };
    const data = await loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: 'post-9', withNeighbours: false });

    expect(api.getShowcaseFeed).not.toHaveBeenCalled();
    expect(api.getShowcasePost).toHaveBeenCalledWith('post-9');
    expect(data).toEqual({ showcaseItems: [showcaseItem('post-9')] });

    api.getShowcasePost.mockImplementationOnce(async (): Promise<never> => { throw new ApiError('Post not found.', 404); });
    await expect(loadImmersiveSourceData({ api: api as never, source: 'showcase-feed', initialId: 'post-9', withNeighbours: false }))
      .resolves.toEqual({ showcaseItems: [] });
  });

  it('asks one For you page for the neighbours, and keeps the post the reader is on first', async () => {
    const opened = showcaseItem('post-9');
    const api = {
      getShowcaseFeed: vi.fn(async () => ({
        items: [showcaseItem('post-1'), showcaseItem('post-2')],
        feedSessionId: 'session-1',
        algorithmVersion: 'hybrid-v1',
      })),
    };
    const data = await loadShowcaseReelNeighbours({ api, selected: opened });

    expect(api.getShowcaseFeed.mock.calls).toEqual([[{ limit: SHOWCASE_FEED_PAGE_SIZE, sort: 'for-you' }]]);
    expect(data).toEqual({
      showcaseItems: [opened, showcaseItem('post-1'), showcaseItem('post-2')],
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
    });

    // Served in the page too: the page's copy (its delivery) goes first, once.
    const served = { ...showcaseItem('post-9'), recommendation: { deliveryId: 'delivery-9', position: 1, algorithmVersion: 'hybrid-v1' } } as ShowcaseFeedItem;
    api.getShowcaseFeed.mockResolvedValueOnce({ items: [showcaseItem('post-1'), served], feedSessionId: 'session-2', algorithmVersion: 'hybrid-v1' });
    const again = await loadShowcaseReelNeighbours({ api, selected: opened, mediaOnly: true });
    expect(api.getShowcaseFeed).toHaveBeenLastCalledWith({ limit: SHOWCASE_FEED_PAGE_SIZE, sort: 'for-you', category: 'media' });
    expect(again.showcaseItems).toEqual([served, showcaseItem('post-1')]);
    expect(again.feedSessionId).toBe('session-2');
  });

  // Pixel_9a, 2026-11-25: a link opened Saree on Home's cached page (row 9 of
  // 11); the reel's refetch read a new ranked page without Fox, His Majesty
  // and Peeling. Dropped, they moved Saree to row 6, and Android drew row 9
  // (NEELAKURINJI) at the old offset until the alignment scroll put it back.
  it("keeps a For you reel's posts through a refetch whose new page left them out", () => {
    const delivered = (id: string, deliveryId: string) => (
      { ...showcaseItem(id), recommendation: { deliveryId, position: 0, algorithmVersion: 'v4' } } as ShowcaseFeedItem
    );
    const homeIds = ['fox', 'female', 'minnal', 'venom', 'mahabali', 'majesty', 'peeling', 'founder', 'intense', 'saree', 'robot'];
    const previous = { showcaseItems: homeIds.map((id) => delivered(id, `home-${id}`)), feedSessionId: 'home-session', algorithmVersion: 'v4' };
    const pageIds = ['saree', 'chai', 'female', 'minnal', 'venom', 'mahabali', 'neelakurinji', 'founder', 'munnar', 'intense'];
    const next = { showcaseItems: pageIds.map((id) => delivered(id, `reel-${id}`)), feedSessionId: 'reel-session', algorithmVersion: 'v5' };

    const kept = keepReelPagePosts(previous, next, 'saree');
    const ids = kept.showcaseItems?.map((item) => item.id);
    // Every post stays on its row, the opened one included; the page's new posts follow.
    expect(ids).toEqual([...homeIds, 'chai', 'neelakurinji', 'munnar']);
    expect(ids?.indexOf('saree')).toBe(9);
    // A post the new page holds is the new page's copy, with its delivery.
    expect(kept.showcaseItems?.[9].recommendation?.deliveryId).toBe('reel-saree');
    // A post it left out keeps no delivery: the reel files its events under the
    // new page's session, which never served that delivery.
    expect(kept.showcaseItems?.[0].id).toBe('fox');
    expect(kept.showcaseItems?.[0] && 'recommendation' in kept.showcaseItems[0]).toBe(false);
    expect(kept.showcaseItems?.[10].id).toBe('robot');
    expect(kept.showcaseItems?.[10] && 'recommendation' in kept.showcaseItems[10]).toBe(false);
    // The session is the new page's.
    expect(kept.feedSessionId).toBe('reel-session');
    expect(kept.algorithmVersion).toBe('v5');
  });

  it("lets the opened post go when the refetch could not read it, and leaves the post alone's reads as they come", () => {
    const previous = { showcaseItems: [showcaseItem('a'), showcaseItem('gone'), showcaseItem('b')], feedSessionId: 'home-session' };
    const next = { showcaseItems: [showcaseItem('b'), showcaseItem('c')], feedSessionId: 'reel-session' };
    // Deleted, made private or behind a block: the reel says so (`selectionMissing`).
    expect(keepReelPagePosts(previous, next, 'gone').showcaseItems?.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    // A read of the post alone, or a reel that held the post alone, takes the answer as it is.
    const alone = { showcaseItems: [showcaseItem('gone')] };
    expect(keepReelPagePosts(previous, alone, 'gone')).toBe(alone);
    expect(keepReelPagePosts(alone, next, 'gone')).toBe(next);
    expect(keepReelPagePosts(undefined, next, 'gone')).toBe(next);
  });

  // A link to a post in no lane but in the reader's Saved pages opens on those
  // pages (`readCachedImmersiveSourceSnapshot`), which carry no feed session:
  // the first For you page puts the post first, and its row moved the same way.
  it('keeps the Saved pages a For you reel opened on through its first page read', () => {
    const saved = { showcaseItems: [showcaseItem('s1'), showcaseItem('s2'), showcaseItem('opened'), showcaseItem('s3')] };
    const page = { showcaseItems: [showcaseItem('opened'), showcaseItem('p1'), showcaseItem('s2')], feedSessionId: 'reel-session' };
    const kept = keepReelPagePosts(saved, page, 'opened');
    expect(kept.showcaseItems?.map((item) => item.id)).toEqual(['s1', 's2', 'opened', 's3', 'p1']);
    expect(kept.feedSessionId).toBe('reel-session');
  });

  it("draws a loading page under a linked post until its neighbours come, and the page's end when none did", () => {
    expect(linkReelEndSlideState({ status: 'idle', itemCount: 1 })).toBe('loading');
    expect(linkReelEndSlideState({ status: 'pending', itemCount: 1 })).toBe('loading');
    expect(linkReelEndSlideState({ status: 'error', itemCount: 1 })).toBe('error');
    expect(linkReelEndSlideState({ status: 'success', itemCount: 1 })).toBe('end');
    // Loaded: the reel ends at its last post, as a reel opened from a link always has.
    expect(linkReelEndSlideState({ status: 'success', itemCount: 13 })).toBeNull();
    // Nothing on screen yet (the post is still being read, or is gone): nothing after it either.
    expect(linkReelEndSlideState({ status: 'idle', itemCount: 0 })).toBeNull();
  });

  it("opens a failure the library has not reached from the Failed scope's own pages, and only that one", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [{ generations: [generation('gen-1')] }],
      pageParams: [null],
    });
    queryClient.setQueryData(profileFailedGenerationsQueryKey('user-1'), {
      pages: [{
        generations: [
          generation('failed-40', { status: 'failed', output_url: null }),
          generation('failed-41', { status: 'failed', output_url: null }),
        ],
      }],
      pageParams: [null],
    });

    const data = readCachedImmersiveSourceData(queryClient, 'studio-creations', 'user-1', 'failed-40');

    expect(data?.generations?.map((item) => item.id)).toEqual(['gen-1', 'failed-40', 'failed-41']);
    // The library rule keeps the other failure out of the reel the status page sits in.
    expect(buildViewerItems('studio-creations', data!, owner, 'failed-40').map((item) => item.id)).toEqual(['gen-1', 'failed-40']);
  });

  it('leaves the Failed pages out, and their age with them, for a run the library already holds', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['profile-generations', 'user-1'],
      { pages: [{ generations: [generation('gen-1')] }], pageParams: [null] },
      { updatedAt: 2_000 },
    );
    // Read long before, while the Failed scope was last shown.
    queryClient.setQueryData(
      profileFailedGenerationsQueryKey('user-1'),
      { pages: [{ generations: [generation('failed-40', { status: 'failed', output_url: null })] }], pageParams: [null] },
      { updatedAt: 1_000 },
    );

    const snapshot = readCachedImmersiveSourceSnapshot(queryClient, 'studio-creations', 'user-1', 'gen-1');

    expect(snapshot?.data.generations?.map((item) => item.id)).toEqual(['gen-1']);
    // A viewer opened on it is as fresh as the library, not as old as the Failed pages.
    expect(snapshot?.updatedAt).toBe(2_000);
  });

  it("opens an archived creation the library has not reached from the Archived scope's own pages", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [{ generations: [generation('gen-1')] }],
      pageParams: [null],
    });
    queryClient.setQueryData(profileArchivedGenerationsQueryKey('user-1'), {
      pages: [{ generations: [generation('archived-40', { archived_at: '2026-10-01T00:00:00.000Z' })] }],
      pageParams: [null],
    });

    const data = readCachedImmersiveSourceData(queryClient, 'studio-creations', 'user-1', 'archived-40');

    expect(data?.generations?.map((item) => item.id)).toEqual(['gen-1', 'archived-40']);
    // Without it in hand, a run the library lacks is left to the network.
    expect(readCachedImmersiveSourceData(queryClient, 'studio-creations', 'user-1', 'archived-41')).toBeUndefined();
  });
});
