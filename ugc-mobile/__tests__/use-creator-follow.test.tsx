import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'viewer-1' } as { id: string } | null,
    queryArgs: null as Record<string, unknown> | null,
    queryData: undefined as { following: boolean } | undefined,
    mutate: vi.fn(),
    cache: new Map<string, unknown>(),
    invalidated: [] as unknown[],
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (args: Record<string, unknown>) => {
    state.queryArgs = args;
    return { data: state.queryData, isPending: state.queryData === undefined };
  },
  useMutation: (args: { onMutate: (following: boolean) => Promise<unknown>; onError: (e: unknown, f: boolean, c: unknown) => void }) => ({
    mutate: (following: boolean) => {
      state.mutate(following);
      void args.onMutate(following);
    },
    isPending: false,
    __onError: args.onError,
  }),
  useQueryClient: () => ({
    cancelQueries: async () => undefined,
    getQueryData: (key: unknown[]) => state.cache.get(JSON.stringify(key)),
    setQueryData: (key: unknown[], value: unknown) => state.cache.set(JSON.stringify(key), value),
    invalidateQueries: async (input: unknown) => { state.invalidated.push(input); },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: state.user,
    api: { getCreatorFollowState: vi.fn(), setCreatorFollowing: vi.fn() },
  }),
}));

import { useCreatorFollow } from '@/lib/use-creator-follow';

let latest: ReturnType<typeof useCreatorFollow> | null = null;

function Host({ creatorId, enabled }: { creatorId: string | null; enabled: boolean }) {
  latest = useCreatorFollow({ creatorId, enabled });
  return null;
}

function render(props: { creatorId: string | null; enabled: boolean }) {
  act(() => {
    renderer.create(React.createElement(Host, props));
  });
  return latest!;
}

describe('useCreatorFollow', () => {
  beforeEach(() => {
    state.user = { id: 'viewer-1' };
    state.queryArgs = null;
    state.queryData = undefined;
    state.mutate.mockClear();
    state.cache.clear();
    state.invalidated.length = 0;
    latest = null;
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
});
