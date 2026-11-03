import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { refreshProfileArchivedCreationsHead, refreshProfileLibraryHead } from '../lib/profile-library-head';
import { profileArchivedGenerationsQueryOptions, profileOwnerPostsQueryOptions } from '../lib/profile-media-query';

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

describe("refreshing the Creations Archived scope's first page", () => {
  it('makes the request its own first page makes, and merges the answer into its own pages', async () => {
    const headApi = stubApi();
    const gridApi = stubApi();
    // The scope has been opened: its pages are in the cache.
    const queryClient = { getQueryData: vi.fn(() => ({ pages: [], pageParams: [] })), setQueryData: vi.fn() } as never as QueryClient & { setQueryData: ReturnType<typeof vi.fn> };

    await refreshProfileArchivedCreationsHead({ api: headApi as never, queryClient, userId: 'user-1' });
    const options = profileArchivedGenerationsQueryOptions(gridApi as never, 'user-1');
    await options.queryFn({ pageParam: options.initialPageParam });

    // The query sends a cursor of undefined, which the query string leaves out.
    expect(headApi.listGenerations.mock.calls[0]).toEqual([true, { limit: 24, archived: 'only' }]);
    expect(gridApi.listGenerations.mock.calls[0]).toEqual([true, { cursor: undefined, limit: 24, archived: 'only' }]);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['profile-archived-generations', 'user-1'], expect.any(Function));
  });

  it('reads nothing for a reader who never opened the scope', async () => {
    const api = stubApi();
    const queryClient = { getQueryData: vi.fn(() => undefined), setQueryData: vi.fn() } as never as QueryClient & { setQueryData: ReturnType<typeof vi.fn> };

    await refreshProfileArchivedCreationsHead({ api: api as never, queryClient, userId: 'user-1' });

    expect(api.listGenerations).not.toHaveBeenCalled();
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
  });

  it('is what a card feed of archived creations asks the library head for, and leaves the library alone', async () => {
    const api = stubApi();
    const queryClient = { setQueryData: vi.fn() };

    await refreshProfileLibraryHead({ api: api as never, queryClient, userId: 'user-1', library: 'Creations', archived: true });

    expect(api.listGenerations.mock.calls).toEqual([[true, { limit: 24, archived: 'only' }]]);
    expect(queryClient.setQueryData.mock.calls.map(([key]) => key)).toEqual([['profile-archived-generations', 'user-1']]);
  });
});
