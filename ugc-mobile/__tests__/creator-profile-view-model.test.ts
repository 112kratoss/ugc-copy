import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api-client';
import {
  CREATOR_PROFILE_TABS,
  blockedCreatorProfilePage,
  creatorInitial,
  creatorProfileLoadErrorCopy,
  creatorProfileSocialLinks,
  creatorProfileTabItems,
  flattenCreatorProfilePages,
  getNextCreatorProfileOffset,
  normalizeCreatorProfileTab,
  setCachedCreatorProfileBlocked,
  setCachedCreatorProfileFollowing,
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

// Decision D4: a social field holds a handle. Rows saved before the server's
// rule may still hold a link, and a pill that says Instagram must only ever
// open Instagram.
describe('creator social pills', () => {
  const pills = (overrides: Partial<CreatorProfileResponse['profile']>) => creatorProfileSocialLinks(profile(overrides));

  it('opens the platform for a handle, with or without its @', () => {
    expect(pills({ instagramHandle: 'luna.studio', tiktokHandle: '@luna_tok', twitterHandle: '@Luna_X' })).toEqual([
      { label: 'Instagram', url: 'https://instagram.com/luna.studio' },
      { label: 'TikTok', url: 'https://tiktok.com/@luna_tok' },
      { label: 'X', url: 'https://x.com/Luna_X' },
    ]);
  });

  it("reads the handle out of a link on the platform's own host, never opening the stored link", () => {
    expect(pills({
      instagramHandle: 'https://www.instagram.com/luna.studio/?hl=en',
      tiktokHandle: 'tiktok.com/@luna_tok',
      twitterHandle: 'HTTPS://Twitter.com/luna_x',
    })).toEqual([
      { label: 'Instagram', url: 'https://instagram.com/luna.studio' },
      { label: 'TikTok', url: 'https://tiktok.com/@luna_tok' },
      { label: 'X', url: 'https://x.com/luna_x' },
    ]);
  });

  it('leaves out a value that is a link anywhere else, or no handle at all', () => {
    expect(pills({
      websiteUrl: 'https://luna.example',
      instagramHandle: 'https://evil.example/luna',
      tiktokHandle: 'https://tiktok.com.evil.example/@luna',
      twitterHandle: 'javascript:alert(1)',
    })).toEqual([{ label: 'Website', url: 'https://luna.example' }]);
    expect(pills({
      instagramHandle: 'https://instagram.com/',
      tiktokHandle: 'a',
      twitterHandle: 'this_handle_is_too_long_for_x',
    })).toEqual([]);
  });
});

function page(
  creatorId: string,
  offset: number,
  overrides: Partial<CreatorProfileResponse> = {},
): CreatorProfileResponse {
  return {
    profile: profile({ id: creatorId, username: creatorId }),
    ...(offset === 0 ? {
      stats: { publicCreations: 30, totalSaves: 4, totalRemixes: 2, unlocks: 1, totalUnlockSales: 0, toolsUsed: [] },
    } : {}),
    items: [item(`${creatorId}-post-${offset}`)],
    pageInfo: { hasMore: true, nextLimit: 24, nextOffset: offset + 24, limit: 24, offset },
    viewer: { isOwner: false, isFollowing: false, blockedByViewer: false },
    ...overrides,
  };
}

function grid(creatorId: string, pageCount: number): InfiniteData<CreatorProfileResponse, number> {
  const offsets = Array.from({ length: pageCount }, (_, index) => index * 24);
  return { pages: offsets.map((offset) => page(creatorId, offset)), pageParams: offsets };
}

describe('creator grid cache writers', () => {
  it('writes a follow into every cached page of that creator and nowhere else', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['creator-profile', 'infinite', 'luna'], grid('luna', 2));
    queryClient.setQueryData(['creator-profile', 'infinite', 'Luna'], grid('luna', 1));
    const other = grid('nova', 1);
    queryClient.setQueryData(['creator-profile', 'infinite', 'nova'], other);
    const otherUpdatedAt = queryClient.getQueryState(['creator-profile', 'infinite', 'nova'])?.dataUpdatedAt;

    setCachedCreatorProfileFollowing(queryClient, 'luna', true);

    for (const key of ['luna', 'Luna']) {
      const cached = queryClient.getQueryData<InfiniteData<CreatorProfileResponse>>(['creator-profile', 'infinite', key]);
      expect(cached?.pages.map((cachedPage) => cachedPage.viewer.isFollowing)).toEqual(key === 'luna' ? [true, true] : [true]);
      expect(cached?.pages[0].items).toHaveLength(1);
    }
    // Another creator's grid is not rewritten, so its age stands too.
    expect(queryClient.getQueryData(['creator-profile', 'infinite', 'nova'])).toBe(other);
    expect(queryClient.getQueryState(['creator-profile', 'infinite', 'nova'])?.dataUpdatedAt).toBe(otherUpdatedAt);
  });

  it('turns a blocked creator\'s grid into the page the server now answers', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['creator-profile', 'infinite', 'luna'], grid('luna', 3));
    const other = grid('nova', 2);
    queryClient.setQueryData(['creator-profile', 'infinite', 'nova'], other);

    setCachedCreatorProfileBlocked(queryClient, 'luna');

    const blocked = queryClient.getQueryData<InfiniteData<CreatorProfileResponse, number>>(['creator-profile', 'infinite', 'luna']);
    expect(blocked?.pageParams).toEqual([0]);
    expect(blocked?.pages).toEqual([blockedCreatorProfilePage(page('luna', 0))]);
    expect(blocked?.pages[0]).toMatchObject({
      items: [],
      pageInfo: { hasMore: false, nextOffset: null, nextLimit: null },
      viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
      stats: { publicCreations: 30 },
    });
    expect(getNextCreatorProfileOffset(blocked!.pages[0])).toBeUndefined();
    expect(queryClient.getQueryData(['creator-profile', 'infinite', 'nova'])).toBe(other);
  });
});

describe('creator page load errors', () => {
  it('names a missing creator, with Explore as the way on', () => {
    expect(creatorProfileLoadErrorCopy(new ApiError('Creator not found.', 404))).toEqual({
      title: 'Creator not found',
      body: 'This profile may have been removed, or the handle may have changed.',
      canRetry: false,
    });
  });

  // A rate limit clears with time; the connection is fine.
  it('asks the reader to wait out a rate limit, for as long as the server said', () => {
    const limited = (retryAfterSeconds?: number) => creatorProfileLoadErrorCopy(
      new ApiError('Too many requests.', 429, retryAfterSeconds === undefined ? { code: 'RATE_LIMITED' } : { retryAfterSeconds }),
    );
    expect(limited(30)).toEqual({
      title: 'Could not load creator',
      body: 'Too many requests in a short time. Try again in 30 seconds.',
      canRetry: true,
    });
    expect(limited(1).body).toBe('Too many requests in a short time. Try again in 1 second.');
    expect(limited(125).body).toBe('Too many requests in a short time. Try again in 3 minutes.');
    expect(limited().body).toBe('Too many requests in a short time. Wait a moment, then try again.');
  });

  it('keeps the connection advice for every other failure', () => {
    for (const error of [new ApiError('offline', 0), new ApiError('boom', 500), new Error('boom'), null]) {
      expect(creatorProfileLoadErrorCopy(error)).toEqual({
        title: 'Could not load creator',
        body: 'Check your connection, then try again.',
        canRetry: true,
      });
    }
  });
});
