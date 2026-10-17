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
      limit: 49,
      offset: 0,
      visibility: 'archived',
    });
    expect(result).toEqual({
      ok: true,
      posts,
      pageInfo: {
        hasMore: false,
        limit: 48,
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
      freeUnlockCount: 20,
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
      // Paid sales and free unlocks apart (decision 6, 2026-10-17).
      summary: {
        earningsUsdCents: 12_300,
        listingCount: 18,
        salesCount: 42,
        freeUnlockCount: 20,
      },
    });
  });

  // 03-7: the seller dashboard asks the server for listings instead of paging
  // through every post to find the ones with a recipe.
  it.each(['1', 'true'])('asks for listings only on listingsOnly=%s, with paging and the summary unchanged', async (value) => {
    const loadOwnerPosts = vi.fn(async () => [{ id: 'post-1' }, { id: 'post-2' }]) satisfies LoadOwnerPosts;
    const loadOwnerPostSalesSummary = vi.fn(async () => ({
      earningsUsdCents: 1_530,
      listingCount: 2,
      salesCount: 2,
      freeUnlockCount: 5,
    })) satisfies LoadOwnerPostSalesSummary;

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({
        scope: 'owner',
        listingsOnly: value,
        includeArchived: 'true',
        includeSummary: 'true',
        limit: '1',
      }),
      loadOwnerPosts,
      loadOwnerPostSalesSummary,
    });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', {
      includeArchived: true,
      limit: 2,
      offset: 0,
      visibility: 'all',
      listingsOnly: true,
    });
    expect(result).toEqual({
      ok: true,
      posts: [{ id: 'post-1' }],
      pageInfo: {
        hasMore: true,
        limit: 1,
        nextOffset: 1,
        offset: 0,
      },
      summary: {
        earningsUsdCents: 1_530,
        listingCount: 2,
        salesCount: 2,
        freeUnlockCount: 5,
      },
    });
  });

  it.each([null, '0', 'false', 'yes'])('lists every post when listingsOnly is %s', async (value) => {
    const loadOwnerPosts = vi.fn(async () => []) satisfies LoadOwnerPosts;
    const searchParams = new URLSearchParams({ scope: 'owner' });
    if (value !== null) searchParams.set('listingsOnly', value);

    await listOwnerPostsForRoute({ userId: 'user-1', searchParams, loadOwnerPosts });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', {
      includeArchived: false,
      limit: 49,
      offset: 0,
      visibility: 'all',
    });
  });

  it('keeps a listings cursor to the listings it paged', async () => {
    const boundary = { id: '00000000-0000-0000-0000-000000000002', createdAt: '2026-09-20T12:00:00.123456+00:00' };
    const loadOwnerPosts = vi.fn(async () => [
      { ...boundary },
      { ...boundary, id: '00000000-0000-0000-0000-000000000003' },
    ]) satisfies LoadOwnerPosts;
    const listings = { scope: 'owner', listingsOnly: '1', limit: '1' };

    const first = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({ ...listings, pagination: 'cursor' }),
      loadOwnerPosts,
    });
    if (!first.ok || !first.pageInfo.nextCursor) throw new Error('expected a next cursor');
    const cursor = first.pageInfo.nextCursor;

    await expect(listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({ scope: 'owner', cursor, limit: '1' }),
      loadOwnerPosts,
    })).resolves.toMatchObject({ ok: false, status: 400 });
    await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams({ ...listings, cursor }),
      loadOwnerPosts,
    });

    expect(loadOwnerPosts).toHaveBeenLastCalledWith('user-1', expect.objectContaining({
      after: boundary,
      listingsOnly: true,
    }));
  });
});
