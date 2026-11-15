import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: { id: 'viewer-1' } as { id: string } | null,
  setCreatorFollowing: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: state.user, api: { setCreatorFollowing: state.setCreatorFollowing } }),
}));

vi.mock('expo-router', () => ({
  router: { push: state.push },
}));

import { creatorFollowStateQueryKey } from '@/lib/use-creator-follow';
import { useSearchCreatorFollow } from '@/lib/use-search-creator-follow';

// Follow on a creator row of search (2026-11-15): it follows in place, with
// the creator page's request, and agrees with what another screen learns.

type Creator = { id: string; username: string; isFollowing: boolean };
let latest: ReturnType<typeof useSearchCreatorFollow> | null = null;
let client: QueryClient;

// The search the row is drawn on: where a visitor's sign-up comes back to.
const SEARCH = '/search?q=harbour%20lights&type=creators';

function Host({ creator, returnTo }: { creator: Creator; returnTo: string }) {
  latest = useSearchCreatorFollow(creator, { returnTo });
  return null;
}

async function render(creator: Creator, returnTo = SEARCH) {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(
      <QueryClientProvider client={client}>
        <Host creator={creator} returnTo={returnTo} />
      </QueryClientProvider>,
    );
  });
  return {
    tree: tree!,
    async update(next: Creator) {
      await act(async () => {
        tree!.update(
          <QueryClientProvider client={client}>
            <Host creator={next} returnTo={returnTo} />
          </QueryClientProvider>,
        );
      });
    },
  };
}

const luna: Creator = { id: 'c1', username: 'luna', isFollowing: false };

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  state.user = { id: 'viewer-1' };
  state.setCreatorFollowing.mockReset();
  state.push.mockReset();
  latest = null;
});

afterEach(() => {
  client.clear();
});

describe('useSearchCreatorFollow', () => {
  it('shows what the answer says, and follows in place, telling the creator page and the reel', async () => {
    let answer: (value: { following: boolean }) => void = () => {};
    state.setCreatorFollowing.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { tree } = await render(luna);
    expect(latest).toMatchObject({ offered: true, following: false, pending: false, failed: false });

    await act(async () => latest!.press());
    expect(state.setCreatorFollowing).toHaveBeenCalledWith('c1', true);
    // Answered at once, before the server has.
    expect(latest).toMatchObject({ following: true, pending: true });
    expect(client.getQueryData(creatorFollowStateQueryKey('c1'))).toEqual({ following: true });

    await act(async () => answer({ following: true }));
    expect(latest).toMatchObject({ following: true, pending: false, failed: false });
    expect(state.push).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('puts a refused press back, and says so', async () => {
    state.setCreatorFollowing.mockRejectedValue(new Error('refused'));
    const { tree } = await render({ ...luna, isFollowing: true });
    await act(async () => latest!.press());
    expect(state.setCreatorFollowing).toHaveBeenCalledWith('c1', false);
    expect(latest).toMatchObject({ following: true, pending: false, failed: true });
    expect(client.getQueryData(creatorFollowStateQueryKey('c1'))).toEqual({ following: true });
    await act(async () => tree.unmount());
  });

  it('agrees with a follow made on another screen while the search stood under it', async () => {
    const { tree } = await render(luna);
    // The creator page's own Follow, pressed on the profile pushed over the search.
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('c1'), { following: true }); });
    expect(latest?.following).toBe(true);
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('other'), { following: false }); });
    expect(latest?.following).toBe(true);
    await act(async () => tree.unmount());
  });

  it('takes a newer answer over what it learned before it', async () => {
    const { tree, update } = await render(luna);
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('c1'), { following: true }); });
    await update({ ...luna, isFollowing: true });
    await update({ ...luna, isFollowing: false });
    expect(latest?.following).toBe(false);
    await act(async () => tree.unmount());
  });

  it('keeps a follow made on the row when the row comes back on the answer it came in (review of #828, S4)', async () => {
    state.setCreatorFollowing.mockResolvedValue({ following: true });
    const first = await render(luna);
    await act(async () => latest!.press());
    expect(latest?.following).toBe(true);
    // Something typed: the start screen goes, and its rows with it.
    await act(async () => first.tree.unmount());
    // The box emptied again: the start screen comes back on the answer kept
    // for the opening, from before the follow.
    const second = await render(luna);
    expect(latest).toMatchObject({ following: true, pending: false, failed: false });
    await act(async () => second.tree.unmount());
  });

  it('comes on show with a follow made on another screen before it, and with the answer when nothing was', async () => {
    client.setQueryData(creatorFollowStateQueryKey('c1'), { following: true });
    const followed = await render(luna);
    expect(latest?.following).toBe(true);
    await act(async () => followed.tree.unmount());

    const other = await render({ id: 'c2', username: 'nova', isFollowing: true });
    expect(latest?.following).toBe(true);
    await act(async () => other.tree.unmount());
  });

  it('drops the refusal once the follow is made another way, and never shows it again (review of #828, N12)', async () => {
    state.setCreatorFollowing.mockRejectedValue(new Error('refused'));
    const { tree } = await render(luna);
    await act(async () => latest!.press());
    expect(latest).toMatchObject({ following: false, failed: true });
    // A read that says what the row was put back to leaves the sentence true.
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('c1'), { following: false }); });
    expect(latest).toMatchObject({ following: false, failed: true });
    // The creator page's own Follow, pressed on the profile opened from the row.
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('c1'), { following: true }); });
    expect(latest).toMatchObject({ following: true, failed: false });
    // Unfollowed there again: the old refusal does not come back.
    await act(async () => { client.setQueryData(creatorFollowStateQueryKey('c1'), { following: false }); });
    expect(latest).toMatchObject({ following: false, failed: false });
    await act(async () => tree.unmount());
  });

  it('drops the refusal when a newer answer says the follow stands', async () => {
    state.setCreatorFollowing.mockRejectedValue(new Error('refused'));
    const { tree, update } = await render(luna);
    await act(async () => latest!.press());
    expect(latest).toMatchObject({ following: false, failed: true });
    await update({ ...luna, isFollowing: true });
    expect(latest).toMatchObject({ following: true, failed: false });
    await act(async () => tree.unmount());
  });

  it('drops a creator page read still on its way as the press lands, as the reel does (#679; review of #828, S7)', async () => {
    // A finger rested on the row long enough to read the page, then moved off.
    let land: (page: unknown) => void = () => {};
    const pageKey = ['creator-profile', 'luna'];
    void client.prefetchQuery({ queryKey: pageKey, queryFn: () => new Promise((resolve) => { land = resolve; }) });
    expect(client.getQueryState(pageKey)?.fetchStatus).toBe('fetching');
    state.setCreatorFollowing.mockResolvedValue({ following: true });
    const { tree } = await render(luna);
    await act(async () => latest!.press());
    expect(client.getQueryState(pageKey)?.fetchStatus).toBe('idle');
    // The read lands with the answer from before the press: nobody keeps it.
    await act(async () => land({ pages: [{ profile: { id: 'c1' }, viewer: { isFollowing: false } }], pageParams: [null] }));
    expect(client.getQueryData(pageKey)).toBeUndefined();
    await act(async () => tree.unmount());
  });

  it('asks a visitor or a guest to sign up, and comes back to the same search (review of #828, S5)', async () => {
    state.user = null;
    const { tree } = await render(luna);
    expect(latest?.offered).toBe(true);
    await act(async () => latest!.press());
    expect(state.setCreatorFollowing).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledWith({ pathname: '/join', params: { returnTo: SEARCH } });
    await act(async () => tree.unmount());
  });

  it('offers nothing on the viewer\'s own row', async () => {
    state.user = { id: 'c1' };
    const { tree } = await render(luna);
    expect(latest?.offered).toBe(false);
    await act(async () => latest!.press());
    expect(state.setCreatorFollowing).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});
