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

function Host({ creator }: { creator: Creator }) {
  latest = useSearchCreatorFollow(creator);
  return null;
}

async function render(creator: Creator) {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(
      <QueryClientProvider client={client}>
        <Host creator={creator} />
      </QueryClientProvider>,
    );
  });
  return {
    tree: tree!,
    async update(next: Creator) {
      await act(async () => {
        tree!.update(
          <QueryClientProvider client={client}>
            <Host creator={next} />
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

  it('asks a visitor or a guest to sign up, and comes back to the creator', async () => {
    state.user = null;
    const { tree } = await render(luna);
    expect(latest?.offered).toBe(true);
    await act(async () => latest!.press());
    expect(state.setCreatorFollowing).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledWith({ pathname: '/join', params: { returnTo: '/creators/luna' } });
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
