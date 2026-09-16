(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>,
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((entry) => entry !== listener);
        },
      };
    },
  },
}));

import { PROFILE_REVALIDATION_COOLDOWN_MS } from '../lib/profile-media-refresh';
import { useProfileMediaRevalidation } from '../lib/use-profile-media-revalidation';

type ProbeProps = Parameters<typeof useProfileMediaRevalidation>[0];

function Probe(props: ProbeProps) {
  useProfileMediaRevalidation(props);
  return null;
}

async function settle() {
  await renderer.act(async () => {
    await Promise.resolve();
  });
}

function returnToApp() {
  for (const state of ['background', 'active']) {
    appState.currentState = state;
    renderer.act(() => {
      appState.listeners.forEach((listener) => listener(state));
    });
  }
}

function failWith(status: number, details?: unknown) {
  return vi.fn(async () => {
    throw Object.assign(new Error(`Request failed with status ${status}`), { status, details });
  });
}

describe('useProfileMediaRevalidation', () => {
  const stale = { enabled: true, scope: 'Creations', hasData: true, isFetching: false, isStale: true };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
    appState.currentState = 'active';
    appState.listeners = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes a stale library once when its screen gains focus', async () => {
    const refresh = vi.fn(async () => undefined);
    await renderer.act(async () => {
      renderer.create(<Probe {...stale} refresh={refresh} />);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('Creations');
  });

  it('leaves fresh data, data on the wire, a library still loading and an unfocused screen alone', async () => {
    const refresh = vi.fn(async () => undefined);
    await renderer.act(async () => {
      renderer.create(<Probe {...stale} isStale={false} refresh={refresh} />);
      renderer.create(<Probe {...stale} isFetching refresh={refresh} />);
      renderer.create(<Probe {...stale} hasData={false} refresh={refresh} />);
      renderer.create(<Probe {...stale} enabled={false} refresh={refresh} />);
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not start another refresh when a failed one settles, however often the fetch state flips', async () => {
    // The loop the audit found: failure leaves data stale, and each settle re-fired the effect.
    const refresh = failWith(500);
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<Probe {...stale} refresh={refresh} />);
    });

    for (let flip = 0; flip < 12; flip += 1) {
      await renderer.act(async () => {
        tree.update(<Probe {...stale} isFetching={flip % 2 === 0} refresh={refresh} />);
      });
    }

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('waits out the cooldown between returns to the app and backs off after a failure', async () => {
    const refresh = failWith(500);
    await renderer.act(async () => {
      renderer.create(<Probe {...stale} refresh={refresh} />);
    });
    await settle();

    returnToApp();
    expect(refresh).toHaveBeenCalledTimes(1);

    // One failure doubles the wait, so the plain cooldown is not enough.
    vi.advanceTimersByTime(PROFILE_REVALIDATION_COOLDOWN_MS);
    returnToApp();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROFILE_REVALIDATION_COOLDOWN_MS);
    returnToApp();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('holds off a rate-limited library until the server allows it', async () => {
    const refresh = failWith(429, { retryAfterSeconds: 300 });
    await renderer.act(async () => {
      renderer.create(<Probe {...stale} refresh={refresh} />);
    });
    await settle();

    vi.advanceTimersByTime(240_000);
    returnToApp();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    returnToApp();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('gives each library its own schedule', async () => {
    const refresh = vi.fn(async (_scope: string) => undefined);
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<Probe {...stale} refresh={refresh} />);
    });
    await renderer.act(async () => {
      tree.update(<Probe {...stale} scope="Posts" refresh={refresh} />);
    });
    await renderer.act(async () => {
      tree.update(<Probe {...stale} scope="Creations" refresh={refresh} />);
    });

    expect(refresh.mock.calls.map(([scope]) => scope)).toEqual(['Creations', 'Posts']);
  });
});
