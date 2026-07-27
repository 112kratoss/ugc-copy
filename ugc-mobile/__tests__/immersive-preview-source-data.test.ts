import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  loadImmersiveSourceData,
  readCachedImmersiveSourceData,
} from '../lib/immersive-preview-source-data';
import type { CreatorProfileResponse, ShowcaseFeedItem } from '../lib/types';

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
  it('bounds generation viewer hydration to the visible preview window', async () => {
    const api = {
      getCreatorProfile: vi.fn(),
      getSavedMedia: vi.fn(),
      getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(),
      listGenerations: vi.fn(async () => ({ generations: [] })),
      listOwnerPosts: vi.fn(async () => ({ success: true, posts: [] })),
    };

    await loadImmersiveSourceData({
      api,
      source: 'home-creations',
      initialId: 'generation-1',
    });

    expect(api.listGenerations).toHaveBeenCalledWith(true, { limit: 48 });
    expect(api.listOwnerPosts).toHaveBeenCalledWith({
      includeArchived: true,
      limit: 48,
      visibility: 'all',
    });
  });

  it('loads creator profile source data from the creator profile endpoint', async () => {
    const item = showcaseItem('post-1');
    const api = {
      getCreatorProfile: vi.fn(async () => creatorProfile([item])),
      getSavedMedia: vi.fn(),
      getShowcaseFeed: vi.fn(),
      getShowcasePost: vi.fn(),
      listGenerations: vi.fn(),
      listOwnerPosts: vi.fn(),
    };

    const data = await loadImmersiveSourceData({
      api,
      source: 'creator-profile',
      initialId: 'post-1',
      creatorUsername: 'luna',
    });

    expect(data.showcaseItems).toEqual([item]);
    expect(api.getCreatorProfile).toHaveBeenCalledWith('luna', { limit: 48 });
    expect(api.getShowcaseFeed).not.toHaveBeenCalled();
  });

  it('reads cached creator profile items for creator profile viewer launches', () => {
    const queryClient = new QueryClient();
    const item = showcaseItem('post-1');
    queryClient.setQueryData(['creator-profile', 'luna'], creatorProfile([item]));

    expect(readCachedImmersiveSourceData(queryClient, 'creator-profile', 'user-1', 'post-1')).toEqual({
      showcaseItems: [item],
    });
  });

  it('reads and deduplicates pages from the infinite creator profile cache', () => {
    const queryClient = new QueryClient();
    const first = creatorProfile([showcaseItem('post-1'), showcaseItem('post-2')]);
    const second = creatorProfile([showcaseItem('post-2'), showcaseItem('post-3')]);
    queryClient.setQueryData(['creator-profile', 'infinite', 'luna'], {
      pages: [first, second],
      pageParams: [0, 48],
    });

    expect(readCachedImmersiveSourceData(queryClient, 'creator-profile', 'user-1', 'post-3')).toEqual({
      showcaseItems: [first.items[0], first.items[1], second.items[1]],
    });
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

  it('merges a paginated profile cache with the single-page home cache', () => {
    // profile-generations pages; home-generations does not.
    const queryClient = new QueryClient();
    queryClient.setQueryData(['profile-generations', 'user-1'], {
      pages: [
        { generations: [{ id: 'gen-1', output_url: 'a.png' }] },
        { generations: [{ id: 'gen-2', output_url: 'b.png' }] },
      ],
      pageParams: [null, '24'],
    });
    queryClient.setQueryData(['home-generations', 'user-1'], {
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
    queryClient.setQueryData(['owner-posts-sales-summary', 'user-1'], {
      success: true,
      posts: [{ id: 'post-b', mediaUrl: 'b.png', mediaKind: 'image' }],
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
      'session-1'
    )).toEqual({
      showcaseItems: rankedItems,
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
    });
  });

  it('does not reuse an anonymous ranked session for a signed-in viewer', () => {
    const queryClient = new QueryClient();
    const anonymousItem = { ...showcaseItem('post-1'), title: 'Anonymous ranking' };
    const signedInItem = { ...showcaseItem('post-1'), title: 'Signed-in ranking' };
    queryClient.setQueryData(['showcase-feed', 'infinite', 'anonymous', { sort: 'for-you' }], {
      pages: [{ items: [anonymousItem], feedSessionId: 'anonymous-session' }],
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
      'post-1'
    )).toMatchObject({
      showcaseItems: [{ title: 'Signed-in ranking' }],
      feedSessionId: 'user-session',
    });
  });
});
