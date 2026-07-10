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
});
