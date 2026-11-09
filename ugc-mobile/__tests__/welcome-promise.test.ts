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
import { primeWelcomeCredits, useWelcomeCreditsQuery } from '../lib/use-onboarding-destination';
import {
  loadWelcomePromise,
  rememberWelcomeAnswer,
  resetWelcomePromiseForTests,
  useWelcomePromise,
  WELCOME_PROMISE_STORAGE_KEY,
  welcomePromiseAfterAnswer,
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

describe('what an account tells the phone about the welcome-credit promise (owner 11-09)', () => {
  it('keeps it while the credits are still to come, drops it once this person has had them', () => {
    expect(welcomePromiseAfterAnswer('eligible')).toBe(true);
    // Waiting only on the creator name.
    expect(welcomePromiseAfterAnswer('not_eligible')).toBe(true);
    for (const status of ['claimed', 'already_claimed', 'identity_already_claimed'] as const) {
      expect(welcomePromiseAfterAnswer(status)).toBe(false);
    }
  });

  it('learns nothing from a guest answer, the program being off, or an account from before it', () => {
    expect(welcomePromiseAfterAnswer('requires_account')).toBeNull();
    expect(welcomePromiseAfterAnswer('unavailable')).toBeNull();
    // Also the answer to an account holding 25 credits while the program is
    // off, which may still be owed them (review of #738).
    expect(welcomePromiseAfterAnswer('legacy_ineligible')).toBeNull();
  });
});

describe('the phone remembers it across sign-outs and launches', () => {
  it('promises the credits on a phone that never had an account', async () => {
    const promise = await mountReader();
    expect(promise()).toBe(true);
  });

  it('stops the promise the moment an account here has claimed, while the screen is up', async () => {
    const promise = await mountReader();
    await act(async () => {
      rememberWelcomeAnswer('claimed', '2026-11-09T00:00:00.000Z');
      await settle();
    });
    expect(promise()).toBe(false);
    expect(storage.values.get(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T00:00:00.000Z');
  });

  it('remembers the claim at the next launch, signed out', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T00:00:00.000Z');
    await loadWelcomePromise();
    const promise = await mountReader();
    expect(promise()).toBe(false);
  });

  it('brings the promise back for an account here that still has its credits coming', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, 'earlier');
    const promise = await mountReader();
    expect(promise()).toBe(false);
    await act(async () => {
      rememberWelcomeAnswer('eligible');
      await settle();
    });
    expect(promise()).toBe(true);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);
  });

  it('leaves the record alone for an answer that says nothing', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, 'earlier');
    const promise = await mountReader();
    await act(async () => {
      rememberWelcomeAnswer('unavailable');
      rememberWelcomeAnswer('requires_account');
      rememberWelcomeAnswer('legacy_ineligible');
      await settle();
    });
    expect(promise()).toBe(false);
    expect(storage.values.get(WELCOME_PROMISE_STORAGE_KEY)).toBe('earlier');
  });

  it('keeps an answer learned while the stored one was still being read', async () => {
    storage.values.set(WELCOME_PROMISE_STORAGE_KEY, 'earlier');
    const reading = loadWelcomePromise();
    rememberWelcomeAnswer('eligible');
    await reading;
    await settle();
    const promise = await mountReader();
    expect(promise()).toBe(true);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);
  });

  it('keeps the promise when the store cannot be read', async () => {
    storage.failReads = true;
    const promise = await mountReader();
    expect(promise()).toBe(true);
  });

  it('tries a failed write again with the next answer, so the next launch still knows (review of #738)', async () => {
    const promise = await mountReader();
    storage.failWrites = true;
    await act(async () => {
      rememberWelcomeAnswer('claimed');
      await settle();
    });
    // This launch knows; the store does not yet.
    expect(promise()).toBe(false);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);

    storage.failWrites = false;
    await act(async () => {
      rememberWelcomeAnswer('claimed');
      await settle();
    });
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);

    // And once the store holds it, the same answer writes nothing more.
    const writes = storage.writes;
    rememberWelcomeAnswer('claimed');
    await settle();
    expect(storage.writes).toBe(writes);
  });

  it('survives a storage module that throws outright (review of #738)', async () => {
    const promise = await mountReader();
    storage.throwWrites = true;
    await act(async () => {
      expect(() => rememberWelcomeAnswer('claimed')).not.toThrow();
      await settle();
    });
    expect(promise()).toBe(false);
  });
});

describe('where the phone learns it: the signed-in account\'s own answer (review of #738)', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => client.clear());

  /** A screen that reads the welcome answer, as Home's popup does. */
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

  it('learns a claimed account from the shared welcome query, and the next launch remembers it', async () => {
    auth.user = { id: 'creator-1' };
    auth.getWelcomeCredits = () => Promise.resolve(answer('already_claimed'));
    const promise = await mountReader();
    await mountProbe();
    await act(async () => { await settle(); });
    expect(promise()).toBe(false);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(true);
  });

  it('ignores a slow answer for an account that has since signed out', async () => {
    let answerForA!: (value: WelcomeCreditResponse) => void;
    auth.user = { id: 'account-a' };
    auth.getWelcomeCredits = () => new Promise((resolve) => { answerForA = resolve; });
    const promise = await mountReader();
    const probe = await mountProbe();

    // A signs out before its answer lands; B signs up and is still owed the credits.
    auth.user = { id: 'account-b' };
    auth.getWelcomeCredits = () => Promise.resolve(answer('not_eligible'));
    await probe.rerender();
    expect(promise()).toBe(true);

    await act(async () => {
      answerForA(answer('already_claimed'));
      await settle();
    });
    expect(promise()).toBe(true);
    expect(storage.values.has(WELCOME_PROMISE_STORAGE_KEY)).toBe(false);
  });

  it('learns a claim primed for the signed-in account, and not one primed for another account', async () => {
    auth.user = { id: 'creator-1' };
    auth.getWelcomeCredits = () => Promise.resolve(answer('eligible'));
    const promise = await mountReader();
    await mountProbe();
    expect(promise()).toBe(true);

    await act(async () => {
      primeWelcomeCredits(client, 'someone-else', answer('claimed'));
      await settle();
    });
    expect(promise()).toBe(true);

    await act(async () => {
      primeWelcomeCredits(client, 'creator-1', answer('claimed'));
      await settle();
    });
    expect(promise()).toBe(false);
  });

  it('learns nothing while no one is signed in', async () => {
    const promise = await mountReader();
    const fetches = vi.fn(() => Promise.resolve(answer('claimed')));
    auth.getWelcomeCredits = fetches;
    await mountProbe();
    expect(fetches).not.toHaveBeenCalled();
    expect(promise()).toBe(true);
  });
});
