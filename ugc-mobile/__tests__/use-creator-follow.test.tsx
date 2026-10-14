import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutationArgs = {
  mutationFn: (following: boolean) => unknown;
  onMutate: (following: boolean) => Promise<unknown>;
  onSuccess: (result: { following: boolean } | undefined, following: boolean, context: unknown) => void;
  onError: (error: unknown, following: boolean, context: unknown) => void;
  onSettled: () => void;
};

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'viewer-1' } as { id: string } | null,
    queryArgs: null as Record<string, unknown> | null,
    queryData: undefined as { following: boolean } | undefined,
    mutate: vi.fn(),
    cache: new Map<string, unknown>(),
    invalidated: [] as unknown[],
    mutationFn: null as ((following: boolean) => unknown) | null,
    mutationArgs: null as MutationArgs | null,
    setCreatorFollowing: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (args: Record<string, unknown>) => {
    state.queryArgs = args;
    return { data: state.queryData, isPending: state.queryData === undefined };
  },
  useMutation: (args: MutationArgs) => {
    state.mutationFn = args.mutationFn;
    state.mutationArgs = args;
    return {
    mutate: (following: boolean) => {
      state.mutate(following);
      void args.onMutate(following);
    },
    isPending: false,
    __onError: args.onError,
    };
  },
  useQueryClient: () => ({
    cancelQueries: async () => undefined,
    getQueryData: (key: unknown[]) => state.cache.get(JSON.stringify(key)),
    setQueryData: (key: unknown[], value: unknown) => state.cache.set(JSON.stringify(key), value),
    // Prefix match, as React Query's own filter does; an updater answering
    // `undefined` writes nothing.
    setQueriesData: (filters: { queryKey: unknown[] }, updater: (current: unknown) => unknown) => {
      const prefix = JSON.stringify(filters.queryKey).slice(0, -1);
      for (const [key, value] of [...state.cache]) {
        if (!key.startsWith(prefix)) continue;
        const next = updater(value);
        if (next !== undefined) state.cache.set(key, next);
      }
    },
    invalidateQueries: async (input: unknown) => { state.invalidated.push(input); },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: state.user,
    api: { getCreatorFollowState: vi.fn(), setCreatorFollowing: state.setCreatorFollowing },
  }),
}));

import type { QueryClient } from '@tanstack/react-query';

import { creatorFollowStateQueryKey, prefetchCreatorFollowState, useCreatorFollow } from '@/lib/use-creator-follow';

let latest: ReturnType<typeof useCreatorFollow> | null = null;

function Host({ creatorId, enabled, attribution }: {
  creatorId: string | null;
  enabled: boolean;
  attribution?: { postId: string; deliveryId?: string | null } | null;
}) {
  latest = useCreatorFollow({ creatorId, enabled, attribution });
  return null;
}

function render(props: {
  creatorId: string | null;
  enabled: boolean;
  attribution?: { postId: string; deliveryId?: string | null } | null;
}) {
  act(() => {
    renderer.create(React.createElement(Host, props));
  });
  return latest!;
}

/** Two cached pages of a creator's grid, as the creator page keeps them. */
function creatorGrid(creatorId: string, isFollowing: boolean) {
  const gridPage = (offset: number) => ({
    profile: { id: creatorId, username: creatorId },
    items: [],
    pageInfo: { hasMore: offset === 0, nextLimit: null, nextOffset: offset === 0 ? 24 : null, limit: 24, offset },
    viewer: { isOwner: false, isFollowing, blockedByViewer: false },
  });
  return { pages: [gridPage(0), gridPage(24)], pageParams: [0, 24] };
}

const gridKey = (username: string) => JSON.stringify(['creator-profile', 'infinite', username]);
const followingIn = (key: string) => (state.cache.get(key) as ReturnType<typeof creatorGrid>).pages
  .map((gridPage) => gridPage.viewer.isFollowing);

async function flushMicrotasks() {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe('useCreatorFollow', () => {
  beforeEach(() => {
    state.user = { id: 'viewer-1' };
    state.queryArgs = null;
    state.queryData = undefined;
    state.mutate.mockClear();
    state.cache.clear();
    state.invalidated.length = 0;
    state.mutationFn = null;
    state.mutationArgs = null;
    state.setCreatorFollowing.mockClear();
    latest = null;
  });

  // Audit 02-8: the reel's Follow invalidated `['creator-profile']`, and every
  // cached creator grid read all of its loaded pages again.
  it("writes the answer into that creator's cached grid instead of reading every grid again", async () => {
    const otherGrid = creatorGrid('creator-2', false);
    state.cache.set(gridKey('luna'), creatorGrid('creator-1', false));
    state.cache.set(gridKey('nova'), otherGrid);
    state.queryData = { following: false };
    const result = render({ creatorId: 'creator-1', enabled: true });

    await act(async () => {
      result.toggle();
      await flushMicrotasks();
    });
    // Under the thumb, on the page beneath the reel too.
    expect(followingIn(gridKey('luna'))).toEqual([true, true]);

    state.mutationArgs!.onSuccess({ following: true }, true, undefined);
    state.mutationArgs!.onSettled();

    expect(followingIn(gridKey('luna'))).toEqual([true, true]);
    expect(state.cache.get(gridKey('nova'))).toBe(otherGrid);
    // Only the reel's own answer is asked for again.
    expect(state.invalidated).toEqual([{ queryKey: ['creator-follow-state', 'creator-1'] }]);
  });

  it('puts the grid back as it was when the follow fails', async () => {
    state.cache.set(gridKey('luna'), creatorGrid('creator-1', false));
    state.cache.set(JSON.stringify(['creator-follow-state', 'creator-1']), { following: false });
    state.queryData = { following: false };
    render({ creatorId: 'creator-1', enabled: true });

    const context = await state.mutationArgs!.onMutate(true);
    expect(followingIn(gridKey('luna'))).toEqual([true, true]);

    state.mutationArgs!.onError(new Error('offline'), true, context);

    expect(followingIn(gridKey('luna'))).toEqual([false, false]);
    expect(state.cache.get(JSON.stringify(['creator-follow-state', 'creator-1']))).toEqual({ following: false });
  });

  it('asks the server only for an active slide about someone else', () => {
    render({ creatorId: 'creator-1', enabled: true });
    expect(state.queryArgs?.enabled).toBe(true);
    expect(state.queryArgs?.queryKey).toEqual(['creator-follow-state', 'creator-1']);

    render({ creatorId: 'creator-1', enabled: false });
    expect(state.queryArgs?.enabled).toBe(false);

    render({ creatorId: 'viewer-1', enabled: true });
    expect(state.queryArgs?.enabled).toBe(false);
    expect(latest!.canFollow).toBe(false);
  });

  it('does nothing for a signed-out viewer', () => {
    state.user = null;
    const result = render({ creatorId: 'creator-1', enabled: true });

    expect(result.canFollow).toBe(false);
    act(() => result.toggle());
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('flips the state optimistically and reports loading until the first answer', async () => {
    const loading = render({ creatorId: 'creator-1', enabled: true });
    expect(loading.loading).toBe(true);
    expect(loading.following).toBe(false);

    state.queryData = { following: false };
    const result = render({ creatorId: 'creator-1', enabled: true });
    expect(result.loading).toBe(false);

    await act(async () => {
      result.toggle();
      await Promise.resolve();
    });
    expect(state.mutate).toHaveBeenCalledWith(true);
    expect(state.cache.get(JSON.stringify(['creator-follow-state', 'creator-1']))).toEqual({ following: true });
  });

  // Feed ranking v4, §4: a follow pressed on a post the feed showed names the
  // post and the delivery, so the server can credit the follow to them.
  it('sends the post the Follow was pressed on, and its feed delivery', () => {
    render({ creatorId: 'creator-1', enabled: true, attribution: { postId: 'post-1', deliveryId: '9001' } });
    state.mutationFn?.(true);
    expect(state.setCreatorFollowing).toHaveBeenCalledWith('creator-1', true, { postId: 'post-1', deliveryId: '9001' });

    render({ creatorId: 'creator-1', enabled: true });
    state.mutationFn?.(false);
    expect(state.setCreatorFollowing).toHaveBeenLastCalledWith('creator-1', false, null);
  });
});

describe('prefetchCreatorFollowState', () => {
  it('asks ahead into the cache the reel reads, as fresh as the reel keeps it', async () => {
    const prefetchQuery = vi.fn(async (_args: { queryKey: unknown; queryFn: () => unknown; staleTime: number }) => undefined);
    const api = { getCreatorFollowState: vi.fn(async () => ({ following: true })) };

    await prefetchCreatorFollowState({ prefetchQuery } as unknown as QueryClient, api, 'creator-9');
    render({ creatorId: 'creator-9', enabled: true });

    const args = prefetchQuery.mock.calls[0][0];
    expect(args.queryKey).toEqual(creatorFollowStateQueryKey('creator-9'));
    expect(args.queryKey).toEqual(state.queryArgs?.queryKey);
    expect(args.staleTime).toBe(state.queryArgs?.staleTime);
    await args.queryFn();
    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-9');
  });
});
