// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: vi.fn(async (key: string) => kept.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      kept.set(key, value);
    }),
  };
});
const queries = vi.hoisted(() => ({
  options: [] as Array<{ queryKey: readonly unknown[]; enabled: boolean; staleTime: number; retry: unknown; queryFn: () => Promise<unknown> }>,
  data: undefined as unknown,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: storage.getItem, setItem: storage.setItem },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: (typeof queries.options)[number]) => {
    queries.options.push(options);
    return { data: queries.data };
  },
}));

import { SUPPORT_UPDATES_SEEN_STORAGE_KEY } from '../lib/support-hub-policy/support-hub-policy';
import {
  loadSupportUpdatesSeen,
  markSupportUpdatesSeen,
  readSupportUpdatesSeen,
  resetSupportUpdatesSeenForTests,
  subscribeToSupportUpdatesSeen,
  useSupportUpdatesUnseen,
} from '../lib/support-updates-seen';

const KEY = SUPPORT_UPDATES_SEEN_STORAGE_KEY;

beforeEach(() => {
  resetSupportUpdatesSeenForTests();
  storage.kept.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  storage.getItem.mockImplementation(async (key: string) => storage.kept.get(key) ?? null);
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    storage.kept.set(key, value);
  });
  queries.options.length = 0;
  queries.data = undefined;
});

describe('the seen marker kept on the device', () => {
  it('is read once per run', async () => {
    storage.kept.set(KEY, '2026-11-25T12:00:00.000Z');
    expect(readSupportUpdatesSeen()).toEqual({ loaded: false, seenAt: null });

    await Promise.all([loadSupportUpdatesSeen(), loadSupportUpdatesSeen()]);
    await loadSupportUpdatesSeen();

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledWith(KEY);
    expect(readSupportUpdatesSeen()).toEqual({ loaded: true, seenAt: '2026-11-25T12:00:00.000Z' });
  });

  it('reads a marker that is not a time, or storage that cannot be read, as no look yet', async () => {
    storage.kept.set(KEY, 'garbage');
    await loadSupportUpdatesSeen();
    expect(readSupportUpdatesSeen()).toEqual({ loaded: true, seenAt: null });

    resetSupportUpdatesSeenForTests();
    storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await loadSupportUpdatesSeen();
    expect(readSupportUpdatesSeen()).toEqual({ loaded: true, seenAt: null });
  });

  it('keeps the newest update shown as the last look, and tells whoever draws the dot', async () => {
    const listener = vi.fn();
    subscribeToSupportUpdatesSeen(listener);

    await markSupportUpdatesSeen('2026-11-26T12:00:00.000Z');

    expect(storage.setItem).toHaveBeenCalledWith(KEY, '2026-11-26T12:00:00.000Z');
    expect(readSupportUpdatesSeen()).toEqual({ loaded: true, seenAt: '2026-11-26T12:00:00.000Z' });
    expect(listener).toHaveBeenCalled();
  });

  it('never puts the marker back behind one already kept', async () => {
    storage.kept.set(KEY, '2026-11-26T12:00:00.000Z');

    await markSupportUpdatesSeen('2026-11-20T12:00:00.000Z');
    await markSupportUpdatesSeen(null);

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(readSupportUpdatesSeen().seenAt).toBe('2026-11-26T12:00:00.000Z');
  });

  it('keeps a look for this run when storage refuses it', async () => {
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(markSupportUpdatesSeen('2026-11-26T12:00:00.000Z')).resolves.toBeUndefined();
    expect(readSupportUpdatesSeen().seenAt).toBe('2026-11-26T12:00:00.000Z');
  });
});

describe('useSupportUpdatesUnseen', () => {
  function Probe({ api, enabled, onValue }: {
    api: { getSupportUpdates: (params?: { limit?: number }) => Promise<{ latestAt: string | null }> };
    enabled: boolean;
    onValue: (value: boolean) => void;
  }) {
    onValue(useSupportUpdatesUnseen({ api: api as never, enabled }));
    return null;
  }

  it('asks for one update\'s page, at most once a minute and only while enabled, for when the newest came out', async () => {
    const api = { getSupportUpdates: vi.fn(async () => ({ latestAt: '2026-11-26T12:00:00.000Z' })) };
    const values: boolean[] = [];
    await act(async () => {
      renderer.create(<Probe api={api} enabled={false} onValue={(value) => values.push(value)} />);
    });

    const options = queries.options.at(-1)!;
    expect(options.queryKey).toEqual(['support-updates', 'latest']);
    expect(options.enabled).toBe(false);
    expect(options.staleTime).toBe(60_000);
    // A dot is not worth asking again for.
    expect(options.retry).toBe(false);
    await expect(options.queryFn()).resolves.toBe('2026-11-26T12:00:00.000Z');
    expect(api.getSupportUpdates).toHaveBeenCalledWith({ limit: 1 });
  });

  it('draws the dot for an update newer than the last look, once the marker has been read', async () => {
    storage.kept.set(KEY, '2026-11-20T12:00:00.000Z');
    queries.data = '2026-11-26T12:00:00.000Z';
    const api = { getSupportUpdates: vi.fn() };
    const values: boolean[] = [];
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Probe api={api} enabled onValue={(value) => values.push(value)} />);
    });

    // Nothing until the marker is read, then the dot.
    expect(values[0]).toBe(false);
    expect(values.at(-1)).toBe(true);

    // A look at Updates takes it off at once.
    await act(async () => {
      await markSupportUpdatesSeen('2026-11-26T12:00:00.000Z');
    });
    expect(values.at(-1)).toBe(false);
    act(() => tree.unmount());
  });

  it('draws no dot while the newest is unknown or its read failed', async () => {
    queries.data = undefined;
    const values: boolean[] = [];
    await act(async () => {
      renderer.create(<Probe api={{ getSupportUpdates: vi.fn() }} enabled onValue={(value) => values.push(value)} />);
    });
    expect(values.every((value) => value === false)).toBe(true);
  });
});
