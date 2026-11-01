import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import {
  buildViewerItems,
  loadImmersiveSourceData,
  readCachedImmersiveSourceData,
  readCachedImmersiveSourceSnapshot,
} from '../lib/immersive-preview-source-data';
import { profileFailedGenerationsQueryKey } from '../lib/profile-media-query';
import { SHOWCASE_FEED_PAGE_SIZE } from '../lib/showcase-feed-query';
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
});
