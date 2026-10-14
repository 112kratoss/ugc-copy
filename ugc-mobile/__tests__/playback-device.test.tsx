(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 35, constants: {} } }));

import {
  createNetworkKindStore,
  normalizeNetworkType,
  readPlaybackNetwork,
  useNetworkKind,
  type NativeNetworkModule,
} from '../lib/playback-device';
import type { PlaybackNetwork } from '../lib/playback-metrics';

type NetworkState = { type?: string | null } | null | undefined;

/** expo-network's native module as the store sees it: one read, and change events. */
function fakeExpoNetwork(type: string | null) {
  const listeners = new Set<(state: NetworkState) => void>();
  const subscriptions: Array<{ remove: ReturnType<typeof vi.fn> }> = [];
  let answerRead: ((state: NetworkState) => void) | null = null;
  const module = {
    getNetworkStateAsync: vi.fn(() => new Promise<NetworkState>((resolve) => {
      answerRead = resolve;
    })),
    addListener: vi.fn((_event: 'onNetworkStateChanged', listener: (state: NetworkState) => void) => {
      listeners.add(listener);
      const subscription = { remove: vi.fn(() => listeners.delete(listener)) };
      subscriptions.push(subscription);
      return subscription;
    }),
  } satisfies NativeNetworkModule;
  return {
    module,
    subscriptions,
    answerRead: () => answerRead?.({ type }),
    change: (next: string) => {
      for (const listener of [...listeners]) listener({ type: next });
    },
  };
}

async function flush() {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe('normalizeNetworkType', () => {
  it.each([
    ['WIFI', 'wifi'],
    ['ETHERNET', 'wifi'],
    ['CELLULAR', 'cellular'],
    ['NONE', 'none'],
    ['UNKNOWN', 'unknown'],
    [null, 'unknown'],
    ['VPN', 'other'],
    ['BLUETOOTH', 'other'],
  ] as Array<[string | null, PlaybackNetwork]>)('%s is %s', (type, kind) => {
    expect(normalizeNetworkType(type)).toBe(kind);
  });
});

describe('the network kind store', () => {
  it('answers unknown on a binary without expo-network', async () => {
    const store = createNetworkKindStore(() => null);
    const unsubscribe = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toBe('unknown');
    unsubscribe();
  });

  it('reads the kind once, then follows each change, telling subscribers only when it moves', async () => {
    const network = fakeExpoNetwork('CELLULAR');
    const store = createNetworkKindStore(() => network.module);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toBe('unknown');

    await flush();
    network.answerRead();
    await flush();
    expect(store.getSnapshot()).toBe('cellular');
    expect(listener).toHaveBeenCalledTimes(1);

    network.change('WIFI');
    expect(store.getSnapshot()).toBe('wifi');
    network.change('WIFI');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('drops a first read that lands after a change, which is newer', async () => {
    const network = fakeExpoNetwork('CELLULAR');
    const store = createNetworkKindStore(() => network.module);
    const unsubscribe = store.subscribe(() => {});
    await flush();

    network.change('WIFI');
    network.answerRead();
    await flush();
    expect(store.getSnapshot()).toBe('wifi');
    unsubscribe();
  });

  // iOS: removing the last listener cancels expo-network's NWPathMonitor, and
  // a cancelled monitor never reports again.
  it('adds one native listener for the process and keeps it when the last subscriber leaves', async () => {
    const network = fakeExpoNetwork('WIFI');
    const store = createNetworkKindStore(() => network.module);
    const first = store.subscribe(() => {});
    await flush();
    first();

    const listener = vi.fn();
    const second = store.subscribe(listener);
    network.change('CELLULAR');

    expect(network.module.addListener).toHaveBeenCalledTimes(1);
    expect(network.module.getNetworkStateAsync).toHaveBeenCalledTimes(1);
    expect(network.subscriptions[0]?.remove).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe('cellular');
    expect(listener).toHaveBeenCalledTimes(1);
    second();
  });

  it('still takes the first read where change events cannot be added', async () => {
    const network = fakeExpoNetwork('CELLULAR');
    network.module.addListener.mockImplementation(() => {
      throw new Error('no events on this binary');
    });
    const store = createNetworkKindStore(() => network.module);
    const unsubscribe = store.subscribe(() => {});
    await flush();
    network.answerRead();
    await flush();
    expect(store.getSnapshot()).toBe('cellular');
    unsubscribe();
  });

  it('keeps unknown when the first read fails', async () => {
    const store = createNetworkKindStore(() => ({
      getNetworkStateAsync: () => Promise.reject(new Error('read failed')),
    }));
    const unsubscribe = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toBe('unknown');
    unsubscribe();
  });
});

describe('where expo cannot load (this suite, or a binary without the module)', () => {
  it('reads unknown for the metrics and the live hook alike', async () => {
    await expect(readPlaybackNetwork()).resolves.toBe('unknown');

    const seen: PlaybackNetwork[] = [];
    function Probe() {
      seen.push(useNetworkKind());
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Probe />);
    });
    await renderer.act(flush);
    expect(seen.at(-1)).toBe('unknown');
    renderer.act(() => tree.unmount());
  });
});
