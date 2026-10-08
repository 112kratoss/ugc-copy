import { describe, expect, it } from 'vitest';

import {
  CREATOR_PROFILE_TABS,
  creatorInitial,
  creatorProfileSocialLinks,
  creatorProfileTabItems,
  flattenCreatorProfilePages,
  getNextCreatorProfileOffset,
  normalizeCreatorProfileTab,
} from '../lib/creator-profile-view-model';
import type { CreatorProfileResponse, ShowcaseFeedItem } from '../lib/types';

function item(id: string, hasUnlock = false): ShowcaseFeedItem {
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
    asset: hasUnlock ? {
      id: 'asset-1',
      postId: id,
      title: 'Prompt pack',
      accessMode: 'free',
      priceUsdCents: 0,
      previewText: 'Reusable prompt.',
      allowRemix: true,
    } : null,
    canRemix: false,
  };
}

function profile(overrides: Partial<CreatorProfileResponse['profile']> = {}): CreatorProfileResponse['profile'] {
  return {
    id: 'creator-1',
    username: 'luna',
    displayName: 'Luna Studio',
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    ...overrides,
  };
}

describe('creator profile view model', () => {
  it('normalizes tabs and exposes expected v1 tabs', () => {
    expect(CREATOR_PROFILE_TABS.map((tab) => tab.id)).toEqual(['creations', 'unlocks', 'tools']);
    expect(normalizeCreatorProfileTab('unlocks')).toBe('unlocks');
    expect(normalizeCreatorProfileTab(['tools'])).toBe('tools');
    expect(normalizeCreatorProfileTab('posts')).toBe('creations');
    expect(normalizeCreatorProfileTab('unknown')).toBe('creations');
  });

  it('filters unlock tab items without changing post tab order', () => {
    const posts = [item('post-1'), item('post-2', true), item('post-3', true)];

    expect(creatorProfileTabItems(posts, 'creations').map((post) => post.id)).toEqual(['post-1', 'post-2', 'post-3']);
    expect(creatorProfileTabItems(posts, 'unlocks').map((post) => post.id)).toEqual(['post-2', 'post-3']);
    expect(creatorProfileTabItems(posts, 'tools')).toEqual([]);
  });

  it('flattens paginated profile items without duplicate posts', () => {
    const response = (items: ShowcaseFeedItem[], offset: number, nextOffset: number | null): CreatorProfileResponse => ({
      profile: profile(),
      stats: {
        publicCreations: 3,
        totalSaves: 0,
        totalRemixes: 0,
        unlocks: 0,
        totalUnlockSales: 0,
        toolsUsed: [],
      },
      items,
      pageInfo: {
        hasMore: nextOffset !== null,
        nextLimit: nextOffset === null ? null : 24,
        nextOffset,
        limit: 24,
        offset,
      },
      viewer: { isOwner: false, isFollowing: false },
    });
    const firstPage = response([item('post-1'), item('post-2')], 0, 24);
    const secondPage = response([item('post-2'), item('post-3')], 24, null);

    expect(flattenCreatorProfilePages([firstPage, secondPage]).map((post) => post.id)).toEqual([
      'post-1',
      'post-2',
      'post-3',
    ]);
    expect(getNextCreatorProfileOffset(firstPage)).toBe(24);
    expect(getNextCreatorProfileOffset(secondPage)).toBeUndefined();
  });

  it('builds copy-safe social links and initials for creator profiles', () => {
    expect(creatorInitial(profile({ displayName: '  Luna Studio  ' }))).toBe('L');
    expect(creatorInitial(profile({ displayName: '', username: 'batman' }))).toBe('B');
    expect(creatorProfileSocialLinks(profile({
      websiteUrl: 'https://luna.example',
      instagramHandle: '@luna',
      tiktokHandle: 'luna.tok',
      twitterHandle: 'https://x.com/luna',
    }))).toEqual([
      { label: 'Website', url: 'https://luna.example' },
      { label: 'Instagram', url: 'https://instagram.com/luna' },
      { label: 'TikTok', url: 'https://tiktok.com/@luna.tok' },
      { label: 'X', url: 'https://x.com/luna' },
    ]);
  });
});
