(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackNetwork } from '../lib/playback-metrics';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  },
}));

// The phone's network, as lib/playback-device.ts would report it: a store the
// test switches, so the hook re-renders the way it does on a real change.
const network = vi.hoisted(() => ({
  kind: 'unknown' as PlaybackNetwork,
  listeners: new Set<() => void>(),
}));

vi.mock('@/lib/playback-device', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    network.listeners.add(listener);
    return () => {
      network.listeners.delete(listener);
    };
  };
  return { useNetworkKind: () => useSyncExternalStore(subscribe, () => network.kind) };
});

// Reduce Motion, as lib/motion.ts reads it from the phone.
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => motion.reduced }));

import {
  AUTOPLAY_PREFERENCES,
  getAutoplayPreference,
  readAutoplayPreference,
  resetAutoplayPreferenceForTests,
  resolveAutoplayPolicy,
  subscribeAutoplayPreference,
  useAutoplayPolicy,
  useAutoplayPreviewsEnabled,
  writeAutoplayPreference,
  type AutoplayPolicy,
  type AutoplayPreference,
} from '../lib/autoplay-preference';
import { SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS } from '../lib/media-performance';
import { usePreviewPlaybackAllowed } from '../lib/use-preview-playback-allowed';

const STORAGE_KEY = 'autoplay-preference-v1';

function switchNetwork(kind: PlaybackNetwork) {
  renderer.act(() => {
    network.kind = kind;
    for (const listener of [...network.listeners]) listener();
  });
}

async function flush() {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

beforeEach(() => {
  motion.reduced = false;
  storage.values.clear();
  storage.getItem.mockReset();
  storage.getItem.mockImplementation(async (key: string) => storage.values.get(key) ?? null);
  storage.setItem.mockReset();
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    storage.values.set(key, value);
  });
  network.kind = 'unknown';
  network.listeners.clear();
  resetAutoplayPreferenceForTests();
});

const TODAY = { previewsEnabled: true, preparedLimit: SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS, electOnlyAtRest: false };
const NOTHING_AHEAD = { previewsEnabled: true, preparedLimit: 0, electOnlyAtRest: true };
const POSTERS_ONLY = { previewsEnabled: false, preparedLimit: 0, electOnlyAtRest: true };

const TABLE: Array<[AutoplayPreference, PlaybackNetwork, Pick<AutoplayPolicy, 'previewsEnabled' | 'preparedLimit' | 'electOnlyAtRest'>]> = [
  ['always', 'wifi', TODAY],
  ['always', 'cellular', TODAY],
  ['always', 'none', TODAY],
  ['always', 'other', TODAY],
  ['always', 'unknown', TODAY],
  ['wifi', 'wifi', TODAY],
  ['wifi', 'cellular', NOTHING_AHEAD],
  ['wifi', 'none', TODAY],
  ['wifi', 'other', TODAY],
  // A binary without expo-network, or a first read still out: no regression.
  ['wifi', 'unknown', TODAY],
  ['never', 'wifi', POSTERS_ONLY],
  ['never', 'cellular', POSTERS_ONLY],
  ['never', 'none', POSTERS_ONLY],
  ['never', 'other', POSTERS_ONLY],
  ['never', 'unknown', POSTERS_ONLY],
];

describe('the autoplay policy (D3)', () => {
  it('offers Wi-Fi only, Always and Never, in that order', () => {
    expect(AUTOPLAY_PREFERENCES).toEqual(['wifi', 'always', 'never']);
  });

  it.each(TABLE)('%s on %s', (preference, networkKind, expected) => {
    expect(resolveAutoplayPolicy(preference, networkKind)).toEqual({ preference, networkKind, ...expected });
  });

  it('answers the same table from useAutoplayPolicy, live, for every preference and network', async () => {
    let latest: AutoplayPolicy | null = null;
    function Probe() {
      latest = useAutoplayPolicy();
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Probe />);
    });
    await renderer.act(flush);

    for (const [preference, networkKind, expected] of TABLE) {
      await renderer.act(() => writeAutoplayPreference(preference));
      switchNetwork(networkKind);
      expect(latest).toEqual({ preference, networkKind, ...expected });
    }
    renderer.act(() => tree.unmount());
  });

  it('keeps the same policy object while nothing it depends on changes', async () => {
    const seen: AutoplayPolicy[] = [];
    function Probe(_props: { tick: number }) {
      seen.push(useAutoplayPolicy());
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Probe tick={0} />);
    });
    await renderer.act(flush);
    renderer.act(() => tree.update(<Probe tick={1} />));
    expect(seen.at(-1)).toBe(seen.at(-2));
    renderer.act(() => tree.unmount());
  });
});

describe('the stored preference', () => {
  it('answers Wi-Fi only before anything is stored', async () => {
    expect(getAutoplayPreference()).toBe('wifi');
    await expect(readAutoplayPreference()).resolves.toBe('wifi');
  });

  it('starts reading the stored choice as the module loads, before any tile subscribes', async () => {
    storage.values.set(STORAGE_KEY, 'never');
    vi.resetModules();
    const fresh = await import('../lib/autoplay-preference');
    await flush();
    expect(fresh.getAutoplayPreference()).toBe('never');
    expect(storage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('restores the stored choice and tells subscribers', async () => {
    storage.values.set(STORAGE_KEY, 'never');
    const listener = vi.fn();
    const unsubscribe = subscribeAutoplayPreference(listener);
    await flush();

    expect(storage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(getAutoplayPreference()).toBe('never');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('reads storage once per launch', async () => {
    storage.values.set(STORAGE_KEY, 'always');
    await readAutoplayPreference();
    const unsubscribe = subscribeAutoplayPreference(() => {});
    await expect(readAutoplayPreference()).resolves.toBe('always');
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('ignores a stored value it does not know, and a read that fails', async () => {
    storage.values.set(STORAGE_KEY, 'cellular-only');
    await expect(readAutoplayPreference()).resolves.toBe('wifi');

    resetAutoplayPreferenceForTests();
    storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(readAutoplayPreference()).resolves.toBe('wifi');
  });

  it('applies a choice in the same call, tells subscribers, and stores it', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoplayPreference(listener);
    await flush();
    listener.mockClear();

    const written = writeAutoplayPreference('always');
    expect(getAutoplayPreference()).toBe('always');
    expect(listener).toHaveBeenCalledTimes(1);
    await written;
    expect(storage.setItem).toHaveBeenCalledWith(STORAGE_KEY, 'always');
    unsubscribe();
  });

  it('does not let a slow first read undo a choice made while it was out', async () => {
    storage.values.set(STORAGE_KEY, 'never');
    let finishRead!: () => void;
    storage.getItem.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = () => resolve('never');
    }));
    const unsubscribe = subscribeAutoplayPreference(() => {});
    await flush();

    await writeAutoplayPreference('always');
    finishRead();
    await flush();

    expect(getAutoplayPreference()).toBe('always');
    await expect(readAutoplayPreference()).resolves.toBe('always');
    unsubscribe();
  });

  it('keeps a choice for the session when storing it fails', async () => {
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeAutoplayPreference('never')).resolves.toBeUndefined();
    expect(getAutoplayPreference()).toBe('never');
  });

  it('turns previews off only under Never', async () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useAutoplayPreviewsEnabled());
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Probe />);
    });
    await renderer.act(flush);
    expect(seen.at(-1)).toBe(true);

    await renderer.act(() => writeAutoplayPreference('never'));
    expect(seen.at(-1)).toBe(false);
    await renderer.act(() => writeAutoplayPreference('always'));
    expect(seen.at(-1)).toBe(true);

    // A network change does not reach a tile: it asks only whether previews play.
    const renders = seen.length;
    switchNetwork('cellular');
    expect(seen).toHaveLength(renders);
    renderer.act(() => tree.unmount());
  });

  it('lets a preview play only with previews on and Reduce Motion off: the one question every tile asks', async () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(usePreviewPlaybackAllowed());
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Probe />);
    });
    await renderer.act(flush);
    expect(seen.at(-1)).toBe(true);

    await renderer.act(() => writeAutoplayPreference('never'));
    expect(seen.at(-1)).toBe(false);
    await renderer.act(() => writeAutoplayPreference('always'));
    expect(seen.at(-1)).toBe(true);

    motion.reduced = true;
    renderer.act(() => tree.update(<Probe />));
    expect(seen.at(-1)).toBe(false);
    renderer.act(() => tree.unmount());
  });
});
