import { describe, expect, it, vi } from 'vitest';

import {
  listOwnerPostsForRoute,
  type LoadOwnerPostSalesSummary,
  type LoadOwnerPosts,
} from '@/lib/owner-post-list-route-service';

describe('listOwnerPostsForRoute', () => {
  it('rejects unsupported scopes before loading owner posts', async () => {
    const loadOwnerPosts = vi.fn() satisfies LoadOwnerPosts;

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({ scope: 'public' }),
      loadOwnerPosts,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Unsupported posts scope.',
    });
    expect(loadOwnerPosts).not.toHaveBeenCalled();
  });

  it('normalizes archived visibility into an archived owner list request', async () => {
    const posts = [{ id: 'post-1', visibility: 'public' }];
    const loadOwnerPosts = vi.fn(async () => posts) satisfies LoadOwnerPosts;

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({ scope: 'owner', visibility: 'archived' }),
      loadOwnerPosts,
    });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', {
      includeArchived: true,
      visibility: 'archived',
    });
    expect(result).toEqual({
      ok: true,
      posts,
      pageInfo: {
        hasMore: false,
        limit: null,
        nextOffset: null,
        offset: 0,
      },
    });
  });

  it('bounds explicit pages and returns a stable next offset', async () => {
    const loadedPosts = [
      { id: 'post-6' },
      { id: 'post-7' },
      { id: 'post-8' },
      { id: 'post-9' },
    ];
    const loadOwnerPosts = vi.fn(async () => loadedPosts) satisfies LoadOwnerPosts;

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({
        scope: 'owner',
        includeArchived: 'true',
        limit: '3',
        offset: '5',
      }),
      loadOwnerPosts,
    });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', {
      includeArchived: true,
      limit: 4,
      offset: 5,
      visibility: 'all',
    });
    expect(result).toEqual({
      ok: true,
      posts: loadedPosts.slice(0, 3),
      pageInfo: {
        hasMore: true,
        limit: 3,
        nextOffset: 8,
        offset: 5,
      },
    });
  });

  it('loads aggregate seller totals without expanding the requested post page', async () => {
    const posts = [{ id: 'post-1' }, { id: 'post-2' }];
    const loadOwnerPosts = vi.fn(async () => posts) satisfies LoadOwnerPosts;
    const loadOwnerPostSalesSummary = vi.fn(async () => ({
      earningsUsdCents: 12_300,
      listingCount: 18,
      salesCount: 42,
    })) satisfies LoadOwnerPostSalesSummary;

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({
        scope: 'owner',
        includeSummary: 'true',
        limit: '1',
      }),
      loadOwnerPosts,
      loadOwnerPostSalesSummary,
    });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', {
      includeArchived: false,
      limit: 2,
      offset: 0,
      visibility: 'all',
    });
    expect(loadOwnerPostSalesSummary).toHaveBeenCalledWith('user-1');
    expect(result).toMatchObject({
      ok: true,
      posts: [{ id: 'post-1' }],
      summary: {
        earningsUsdCents: 12_300,
        listingCount: 18,
        salesCount: 42,
      },
    });
  });
});
