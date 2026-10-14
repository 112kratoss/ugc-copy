// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryOptions = {
  queryKey: unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
  staleTime: number;
  refetchOnWindowFocus: unknown;
};

const { authUser, getContentPreferences, platform, query } = vi.hoisted(() => ({
  authUser: { current: { id: 'user-1' } as { id: string } | null },
  getContentPreferences: vi.fn(),
  platform: { OS: 'ios' },
  // One object for every render; each test sets what the query holds.
  query: { options: null as QueryOptions | null, state: {} as { data?: { showMature: boolean }; isError?: boolean } },
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: { getContentPreferences }, user: authUser.current }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOptions) => {
    query.options = options;
    return query.state;
  },
}));

import { useMatureReveal } from '@/lib/use-mature-reveal';

function readReveal(needed: boolean) {
  let reveal: string | null = null;
  function Probe() {
    reveal = useMatureReveal(needed);
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(Probe));
  });
  renderer.act(() => tree.unmount());
  return reveal;
}

beforeEach(() => {
  authUser.current = { id: 'user-1' };
  platform.OS = 'ios';
  query.options = null;
  query.state = {};
  getContentPreferences.mockReset();
});

describe('useMatureReveal', () => {
  it("reads the viewer's preference, keyed by the viewer, again whenever the app comes back", async () => {
    getContentPreferences.mockResolvedValue({ showMature: true });
    readReveal(true);

    expect(query.options).toEqual(expect.objectContaining({
      queryKey: ['content-preferences', 'user-1'],
      enabled: true,
      staleTime: 5 * 60 * 1000,
      // Only the website changes it, so the 5-minute staleness must not hold back a return.
      refetchOnWindowFocus: 'always',
    }));
    await expect(query.options!.queryFn()).resolves.toEqual({ showMature: true });
  });

  it('asks nothing while nothing mature is on screen, or while signed out', () => {
    readReveal(false);
    expect(query.options?.enabled).toBe(false);

    authUser.current = null;
    readReveal(true);
    expect(query.options?.enabled).toBe(false);
  });

  it('shows on iOS only with the preference on, and offers nothing until it has been read', () => {
    query.state = { data: { showMature: true } };
    expect(readReveal(true)).toBe('show');
    query.state = { data: { showMature: false } };
    expect(readReveal(true)).toBe('website');
    query.state = {};
    expect(readReveal(true)).toBe('pending');
  });

  it('counts a first read that failed as off, and keeps what a failed refresh had', () => {
    query.state = { isError: true };
    expect(readReveal(true)).toBe('website');
    query.state = { isError: true, data: { showMature: true } };
    expect(readReveal(true)).toBe('show');
  });

  it('never asks on Android, which shows no mature media', () => {
    platform.OS = 'android';
    query.state = { data: { showMature: true } };

    expect(readReveal(true)).toBe('never');
    expect(query.options?.enabled).toBe(false);
  });
});
