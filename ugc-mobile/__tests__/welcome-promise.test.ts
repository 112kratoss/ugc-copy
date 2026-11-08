import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
  failWrites: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (storage.failReads) throw new Error('read failed');
      return storage.values.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (storage.failWrites) throw new Error('write failed');
      storage.values.set(key, value);
    },
    removeItem: async (key: string) => {
      if (storage.failWrites) throw new Error('write failed');
      storage.values.delete(key);
    },
  },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => ({}) }));
vi.mock('../lib/onboarding', () => ({ useOnboarding: () => ({}) }));

import type { WelcomeCreditResponse } from '../lib/types';
import { primeWelcomeCredits } from '../lib/use-onboarding-destination';
import {
  loadWelcomePromise,
  rememberWelcomeAnswer,
  resetWelcomePromiseForTests,
  useWelcomePromise,
  WELCOME_PROMISE_STORAGE_KEY,
  welcomePromiseAfterAnswer,
} from '../lib/welcome-promise';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('what an account tells the phone about the welcome-credit promise (owner 11-09)', () => {
  it('keeps it while the credits are still to come, drops it once they are gone for this person', () => {
    expect(welcomePromiseAfterAnswer('eligible')).toBe(true);
    // Waiting only on the creator name.
    expect(welcomePromiseAfterAnswer('not_eligible')).toBe(true);
    for (const status of ['claimed', 'already_claimed', 'identity_already_claimed', 'legacy_ineligible'] as const) {
      expect(welcomePromiseAfterAnswer(status)).toBe(false);
    }
  });

  it('learns nothing from a guest answer or the program being off', () => {
    expect(welcomePromiseAfterAnswer('requires_account')).toBeNull();
    expect(welcomePromiseAfterAnswer('unavailable')).toBeNull();
  });
});

describe('the phone remembers it across sign-outs and launches', () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failReads = false;
    storage.failWrites = false;
    resetWelcomePromiseForTests();
  });
  afterEach(() => {
    act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  });

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

  it('brings the promise back for an account here that still has its credits waiting', async () => {
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

  it('keeps the promise when the store cannot be read, and shrugs off a failed write', async () => {
    storage.failReads = true;
    storage.failWrites = true;
    const promise = await mountReader();
    expect(promise()).toBe(true);
    await act(async () => {
      expect(() => rememberWelcomeAnswer('claimed')).not.toThrow();
      await settle();
    });
    // This launch still knows; the next one shows what the phone knew before.
    expect(promise()).toBe(false);
  });

  it('learns a claim as soon as a screen primes the shared answer with it', async () => {
    const promise = await mountReader();
    const setQueryData = vi.fn();
    const claimed = { status: 'claimed' } as WelcomeCreditResponse;
    await act(async () => {
      primeWelcomeCredits({ setQueryData }, 'creator-1', claimed);
      await settle();
    });
    expect(setQueryData).toHaveBeenCalledWith(['welcome-credits', 'creator-1'], claimed);
    expect(promise()).toBe(false);
  });
});
