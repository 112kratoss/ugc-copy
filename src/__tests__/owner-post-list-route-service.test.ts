import { describe, expect, it, vi } from 'vitest';

import {
  listOwnerPostsForRoute,
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
    });
  });
});
