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
    // React Query's own client, for a case that needs what it does with reads in flight.
    client: null as unknown,
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
  useQueryClient: () => state.client ?? ({
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
import { InfiniteQueryObserver, MutationObserver, QueryClient as RealQueryClient } from '@tanstack/query-core';

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

/** A read the test lets land when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Luna's grid as her page asks for it, its first page held back until the test lets it land. */
function lunaGridRead(read: Promise<unknown>) {
  return {
    queryKey: ['creator-profile', 'infinite', 'luna'],
    queryFn: () => read,
    initialPageParam: 0,
    getNextPageParam: () => undefined,
  };
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
    state.client = null;
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

  // Review of #679: a creator page read set off before the press (a touch that
  // rested on the creator's handle, then let go) landed after the Follow had
  // written its answer into the cached pages, with the answer from before it.
  it('drops a creator page read nobody is waiting on, so it cannot land with the answer from before the press', async () => {
    const client = new RealQueryClient({ defaultOptions: { queries: { retry: false } } });
    state.client = client;
    const read = deferred<unknown>();
    void client.prefetchInfiniteQuery(lunaGridRead(read.promise));
    render({ creatorId: 'creator-1', enabled: true });

    await state.mutationArgs!.onMutate(true);
    read.resolve(creatorGrid('creator-1', false).pages[0]);
    await flushMicrotasks();

    // The page reads itself when it opens, after the press.
    expect(client.getQueryData(['creator-profile', 'infinite', 'luna'])).toBeUndefined();
  });

  // Dropped, a page's first read would leave the page with nothing on its way,
  // and its next page would hold its load-more at that page count.
  it('leaves alone the read a page on screen is waiting for', async () => {
    const client = new RealQueryClient({ defaultOptions: { queries: { retry: false } } });
    state.client = client;
    const read = deferred<unknown>();
    const page = new InfiniteQueryObserver(client, lunaGridRead(read.promise));
    const unsubscribe = page.subscribe(() => undefined);
    render({ creatorId: 'creator-1', enabled: true });

    await state.mutationArgs!.onMutate(true);
    read.resolve(creatorGrid('creator-1', true).pages[0]);
    await flushMicrotasks();

    expect(page.getCurrentResult().data?.pages).toHaveLength(1);
    unsubscribe();
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
  const MINUTE = 60 * 1000;
  const followKey = (creatorId: string) => creatorFollowStateQueryKey(creatorId);
  const gridQueryKey = (username: string) => ['creator-profile', 'infinite', username];

  function setup() {
    // React Query's own client (the hook's import is a double in this file).
    const client = new RealQueryClient();
    const api = { getCreatorFollowState: vi.fn(async () => ({ following: false })) };
    return { client, api, prefetch: (creatorId: string) => prefetchCreatorFollowState(client as unknown as QueryClient, api, creatorId) };
  }

  it('asks ahead into the cache the reel reads, as fresh as the reel keeps it', async () => {
    const { client, api, prefetch } = setup();
    const prefetchQuery = vi.spyOn(client, 'prefetchQuery');

    await prefetch('creator-9');
    render({ creatorId: 'creator-9', enabled: true });

    const args = prefetchQuery.mock.calls[0][0] as { queryKey: unknown; staleTime: number };
    expect(args.queryKey).toEqual(followKey('creator-9'));
    expect(args.queryKey).toEqual(state.queryArgs?.queryKey);
    expect(args.staleTime).toBe(state.queryArgs?.staleTime);
    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-9');
    expect(client.getQueryData(followKey('creator-9'))).toEqual({ following: false });
  });

  // Device sweep 2026-11-03: asked for as the finger landed, the answer came
  // 1.1–2.4 s after the reel opened, and the pill popped in late.
  it('draws the answer a fresh page of the creator gives at once, and still asks the server', async () => {
    const { client, api, prefetch } = setup();
    api.getCreatorFollowState.mockResolvedValue({ following: true });
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() - 2 * MINUTE });

    const prefetched = prefetch('creator-1');
    // Before the prefetch settles: the window the post grows in reads this at once.
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: true });
    await prefetched;

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: true });
  });

  // Review of #679: a page can say no where the server says yes (one a guest
  // read before signing in, one whose follow lookup failed on the server), and
  // taken as fresh as the page, its answer stood for up to five minutes.
  it("takes the server's answer over a page that says otherwise", async () => {
    const { client, api, prefetch } = setup();
    api.getCreatorFollowState.mockResolvedValue({ following: true });
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', false), { updatedAt: Date.now() - 10 * 1000 });

    const prefetched = prefetch('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: false });
    await prefetched;

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: true });
  });

  it('asks the server when the page is older than the reel keeps an answer for', async () => {
    const { client, api, prefetch } = setup();
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() - 6 * MINUTE });

    await prefetch('creator-1');

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: false });
  });

  it('keeps an answer read later than the page', async () => {
    const { client, api, prefetch } = setup();
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() - 3 * MINUTE });
    client.setQueryData(followKey('creator-1'), { following: false }, { updatedAt: Date.now() - MINUTE });

    await prefetch('creator-1');

    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: false });
    expect(api.getCreatorFollowState).not.toHaveBeenCalled();
  });

  it('draws a page read after the answer held, until the server answers again', async () => {
    const { client, api, prefetch } = setup();
    api.getCreatorFollowState.mockResolvedValue({ following: true });
    client.setQueryData(followKey('creator-1'), { following: false }, { updatedAt: Date.now() - 4 * MINUTE });
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() - MINUTE });

    const prefetched = prefetch('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: true });
    await prefetched;

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: true });
  });

  // A return to a creator's page reads its first page again, so every tile
  // pressed there finds a page newer than the answer held.
  it('asks nothing when a later page says what the answer held says', async () => {
    const { client, api, prefetch } = setup();
    client.setQueryData(followKey('creator-1'), { following: true }, { updatedAt: Date.now() - MINUTE });
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() - 10 * 1000 });

    await prefetch('creator-1');

    expect(api.getCreatorFollowState).not.toHaveBeenCalled();
    expect(client.getQueryState(followKey('creator-1'))?.dataUpdatedAt).toBeGreaterThan(Date.now() - 2 * MINUTE);
  });

  it("reads no other creator's page", async () => {
    const { client, api, prefetch } = setup();
    client.setQueryData(gridQueryKey('nova'), creatorGrid('creator-2', true), { updatedAt: Date.now() });

    await prefetch('creator-1');

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-2'))).toBeUndefined();
  });

  // The page's Follow writes its answer into the page before the server has it,
  // and puts the page back if the request fails: a copy taken meanwhile would stay.
  it('takes nothing from a page while a mutation is in flight', async () => {
    const { client, api, prefetch } = setup();
    client.setQueryData(gridQueryKey('luna'), creatorGrid('creator-1', true), { updatedAt: Date.now() });
    void new MutationObserver(client, { mutationFn: () => new Promise(() => undefined) }).mutate();
    expect(client.isMutating()).toBe(1);

    await prefetch('creator-1');

    expect(api.getCreatorFollowState).toHaveBeenCalledWith('creator-1');
    expect(client.getQueryData(followKey('creator-1'))).toEqual({ following: false });
  });
});
