import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
  failWrites: false,
  throwWrites: false,
  writes: 0,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (storage.failReads) throw new Error('read failed');
      return storage.values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storage.throwWrites) throw new Error('native module missing');
      storage.writes += 1;
      if (storage.failWrites) return Promise.reject(new Error('write failed'));
      storage.values.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      if (storage.throwWrites) throw new Error('native module missing');
      storage.writes += 1;
      if (storage.failWrites) return Promise.reject(new Error('write failed'));
      storage.values.delete(key);
      return Promise.resolve();
    },
  },
}));

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getWelcomeCredits: (() => Promise.resolve({})) as () => Promise<unknown>,
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: auth.user, api: { getWelcomeCredits: () => auth.getWelcomeCredits() } }),
}));
vi.mock('../lib/onboarding', () => ({ useOnboarding: () => ({}) }));

import type { WelcomeCreditResponse } from '../lib/types';
import { useWelcomeCreditsQuery } from '../lib/use-onboarding-destination';
import * as welcomePromise from '../lib/welcome-promise';
import {
  endWelcomePromise,
  loadWelcomePromise,
  resetWelcomePromiseForTests,
  useWelcomePromise,
  WELCOME_PROMISE_STORAGE_KEY,
} from '../lib/welcome-promise';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (status: WelcomeCreditResponse['status']) => ({ status, identityComplete: true }) as WelcomeCreditResponse;

/** A screen that reads the promise, as Home's top bar does. */
function Reader() {
  return React.createElement('promise', { value: useWelcomePromise() });
}

const trees: renderer.ReactTestRenderer[] = [];
async function mountReader() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(React.createElement(Reader));
    await settle();
  });
  trees.push(tree);
  return () => tree.root.findByType('promise' as never).props.value as boolean;
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
  storage.failWrites = false;
  storage.throwWrites = false;
  storage.writes = 0;
  auth.user = null;
  resetWelcomePromiseForTests();
});
afterEach(() => {
  act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
});

// Owner, 2026-11-09: "i signed up and claim the free credits and then i logged out. then it should
// not be saying the 25 free creds". Then, shown that an account made before the program kept the
// promise ("Still says 25"), they chose "Any sign-in ends it": once an account has signed in on
// this phone, a guest here is not promised the welcome credits, whatever that account was told.
describe('the rule', () => {
  it('is only ever ended: no welcome answer brings the promise back any more', () => {
    expect(Object.keys(welcomePromise).sort()).toEqual([
      'WELCOME_PROMISE_STORAGE_KEY',
      'endWelcomePromise',
      'loadWelcomePromise',
      'resetWelcomePromiseForTests',
      'useWelcomePromise',
    ]);
  });
});

describe('the phone remembers it across sign-outs and launches', () => {
  it('promises the credits on a phone that never had an account', async () => {
    const promise = await mountReader();
    expect(promise()).toBe(true);
  });

  it('ends the promise the moment an account signs in here, while the screen is up', async () => {
    const promise = await mountReader();
    await act(async () => {
      endWelcomePromise('2026-11-09T00:00:00.000Z');
      await settle();
    });
    expect(promise()).toBe(false);
    expect(storage.values.get(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T00:00:00.000Z');
  });

  it('remembers it at the next launch, signed out', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T00:00:00.000Z');
    await loadWelcomePromise();
    const promise = await mountReader();
    expect(promise()).toBe(false);
  });

  it('keeps a sign-in learned while the stored record was still being read', async () => {
    const reading = loadWelcomePromise();
    endWelcomePromise();
    await reading;
    await settle();
    const promise = await mountReader();
    expect(promise()).toBe(false);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);
  });

  it('keeps the promise when the store cannot be read', async () => {
    storage.failReads = true;
    const promise = await mountReader();
    expect(promise()).toBe(true);
  });

  it('tries a failed write again at the next sign-in, so the next launch still knows (review of #738)', async () => {
    const promise = await mountReader();
    storage.failWrites = true;
    await act(async () => {
      endWelcomePromise();
      await settle();
    });
    // This launch knows; the store does not yet.
    expect(promise()).toBe(false);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);

    storage.failWrites = false;
    await act(async () => {
      endWelcomePromise();
      await settle();
    });
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);

    // And once the store holds it, a later sign-in writes nothing more.
    const writes = storage.writes;
    endWelcomePromise();
    await settle();
    expect(storage.writes).toBe(writes);
  });

  it('writes nothing for a phone whose store already holds it', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, 'earlier');
    await loadWelcomePromise();
    endWelcomePromise();
    await settle();
    expect(storage.writes).toBe(0);
    expect(storage.values.get(WELCOME_PROMISE_STORAGE_KEY)).toBe('earlier');
  });

  it('survives a storage module that throws outright (review of #738)', async () => {
    const promise = await mountReader();
    storage.throwWrites = true;
    await act(async () => {
      expect(() => endWelcomePromise()).not.toThrow();
      await settle();
    });
    expect(promise()).toBe(false);
  });
});

describe('where the phone learns it: an account signed in, whatever its welcome credits', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => client.clear());

  /** A screen that reads the welcome answer, as the popup mounted over every screen does. */
  function Probe() {
    useWelcomeCreditsQuery();
    return null;
  }
  async function mountProbe() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
      await settle();
    });
    trees.push(tree);
    return {
      async rerender() {
        await act(async () => {
          tree.update(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
          await settle();
        });
      },
    };
  }

  // "Still says 25": the server answers an account made before the program `legacy_ineligible`.
  it.each(['legacy_ineligible', 'eligible', 'not_eligible', 'already_claimed'] as const)(
    'ends it for an account answered %s, and the next launch remembers it',
    async (status) => {
      auth.user = { id: 'creator-1' };
      auth.getWelcomeCredits = () => Promise.resolve(answer(status));
      const promise = await mountReader();
      await mountProbe();
      expect(promise()).toBe(false);
      expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);
    },
  );

  it('ends it before the account’s welcome answer lands, or where it never does', async () => {
    auth.user = { id: 'creator-1' };
    auth.getWelcomeCredits = () => new Promise(() => undefined);
    const promise = await mountReader();
    await mountProbe();
    expect(promise()).toBe(false);
  });

  it('leaves it ended for a second account, even one still owed its credits', async () => {
    auth.user = { id: 'account-a' };
    auth.getWelcomeCredits = () => Promise.resolve(answer('already_claimed'));
    const promise = await mountReader();
    const probe = await mountProbe();
    expect(promise()).toBe(false);

    auth.user = { id: 'account-b' };
    auth.getWelcomeCredits = () => Promise.resolve(answer('not_eligible'));
    await probe.rerender();
    expect(promise()).toBe(false);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);
  });

  it('learns nothing while no one is signed in, guests included', async () => {
    const promise = await mountReader();
    const fetches = vi.fn(() => Promise.resolve(answer('claimed')));
    auth.getWelcomeCredits = fetches;
    await mountProbe();
    expect(fetches).not.toHaveBeenCalled();
    expect(promise()).toBe(true);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);
  });
});
