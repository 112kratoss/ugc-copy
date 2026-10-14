import { describe, expect, it, vi } from 'vitest';

import { refreshProfileLibraryHead } from '../lib/profile-library-head';
import { profileOwnerPostsQueryOptions } from '../lib/profile-media-query';

function stubApi() {
  return {
    listGenerations: vi.fn(async () => ({ generations: [], pagination: { hasMore: false } })),
    listOwnerPosts: vi.fn(async () => ({ posts: [], pageInfo: { hasMore: false, nextCursor: null } })),
    getSavedMedia: vi.fn(async () => ({ items: [], pageInfo: { hasMore: false, nextCursor: null } })),
  };
}

describe('refreshing the Posts library’s first page', () => {
  it('asks for no sales summary: the Wallet reads the totals `/api/profile` carries', async () => {
    const api = stubApi();
    const queryClient = { setQueryData: vi.fn() };

    await refreshProfileLibraryHead({ api: api as never, queryClient, userId: 'user-1', library: 'Posts' });

    expect(api.listOwnerPosts).toHaveBeenCalledTimes(1);
    expect(api.listOwnerPosts.mock.calls[0]).toEqual([{
      includeArchived: true,
      limit: 24,
      offset: 0,
      pagination: 'cursor',
      visibility: 'all',
    }]);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['profile-owner-posts', 'user-1'], expect.any(Function));
  });

  it('makes the request the grid’s own first page makes, so the merged page is the one a refresh would draw', async () => {
    const headApi = stubApi();
    const gridApi = stubApi();

    await refreshProfileLibraryHead({ api: headApi as never, queryClient: { setQueryData: vi.fn() }, userId: 'user-1', library: 'Posts' });
    const options = profileOwnerPostsQueryOptions(gridApi as never, 'user-1');
    await options.queryFn({ pageParam: options.initialPageParam });

    expect(headApi.listOwnerPosts.mock.calls[0]).toEqual(gridApi.listOwnerPosts.mock.calls[0]);
  });
});
