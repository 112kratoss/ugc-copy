// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AccountUser = { id: string; user_metadata: Record<string, unknown> };

// One object for every render, as the real contexts provide.
const authState = vi.hoisted(() => ({
  api: { getOnboardingState: vi.fn() },
  user: null as AccountUser | null,
}));

type InstallState = { identityDeferredAt: string | null; status?: string; completedAt?: string | null };

const onboardingState = vi.hoisted(() => ({
  isHydrated: true,
  state: { identityDeferredAt: null } as InstallState,
  reconcileFromServer: vi.fn(async () => undefined),
  // As the provider's does: the in-memory state changes before the write.
  update: vi.fn(async (value: { identityDeferredAt?: string | null }) => {
    onboardingState.state = { ...onboardingState.state, ...value };
    return onboardingState.state;
  }),
}));

// The real reader needs the whole auth module (Supabase, storage). The account
// record is the web's key, read here as the onboarding destination reads it.
vi.mock('@/lib/auth', async () => {
  const { isIdentityDeferredInMetadata } = await import('../lib/onboarding-destination');
  return {
    useAuth: () => authState,
    isIdentityDeferredOnAccount: (user: AccountUser | null) => isIdentityDeferredInMetadata(user?.user_metadata),
  };
});

vi.mock('@/lib/onboarding', () => ({
  useOnboarding: () => onboardingState,
}));

import { OnboardingServerSync } from '../components/onboarding-server-sync';

const SET_UP_LATER = { creator_profile_onboarding_skipped_version: 1 };
const trees: renderer.ReactTestRenderer[] = [];
let queryClient: QueryClient;

function renderSync(element: React.ReactElement = <OnboardingServerSync />) {
  const wrap = (node: React.ReactElement) => <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(wrap(element));
  });
  trees.push(tree);
  return { tree, update: (node: React.ReactElement = <OnboardingServerSync />) => act(() => tree.update(wrap(node))) };
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  authState.api.getOnboardingState.mockReset().mockReturnValue(new Promise(() => undefined));
  authState.user = { id: 'account-1', user_metadata: SET_UP_LATER };
  onboardingState.isHydrated = true;
  onboardingState.state = { identityDeferredAt: null };
  onboardingState.reconcileFromServer.mockClear();
  onboardingState.update.mockClear();
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  queryClient.clear();
});

// 02-11: "Set up later" chosen on the web or on another device is on record
// for the account; this install keeps its own record of it as well.
describe("the account's Set up later on this install", () => {
  it('is recorded once the install state is read, and only then', () => {
    onboardingState.isHydrated = false;
    const sync = renderSync();
    expect(onboardingState.update).not.toHaveBeenCalled();

    onboardingState.isHydrated = true;
    sync.update();

    expect(onboardingState.update).toHaveBeenCalledTimes(1);
    const [written] = onboardingState.update.mock.calls[0];
    expect(Object.keys(written)).toEqual(['identityDeferredAt']);
    expect(new Date(String(written.identityDeferredAt)).toISOString()).toBe(written.identityDeferredAt);
  });

  it('is written once, also when every effect runs again', () => {
    const inActivity = (mode: 'visible' | 'hidden') => (
      <React.Activity mode={mode}><OnboardingServerSync /></React.Activity>
    );
    const sync = renderSync(inActivity('visible'));
    expect(onboardingState.update).toHaveBeenCalledTimes(1);

    sync.update(inActivity('hidden'));
    sync.update(inActivity('visible'));
    sync.update(inActivity('visible'));

    expect(onboardingState.update).toHaveBeenCalledTimes(1);
  });

  it('leaves an install that has its own record of the choice alone', () => {
    onboardingState.state = { identityDeferredAt: '2026-10-01T09:00:00.000Z' };
    renderSync();

    expect(onboardingState.update).not.toHaveBeenCalled();
  });

  it.each([
    ['an account without it', { id: 'account-2', user_metadata: {} }],
    ['an account with another value under the key', { id: 'account-3', user_metadata: { creator_profile_onboarding_skipped_version: '1' } }],
    ['a guest, which has no account', null],
  ])('writes nothing for %s', (_name, user) => {
    authState.user = user;
    renderSync();

    expect(onboardingState.update).not.toHaveBeenCalled();
  });
});

// It read the account's progress again on every return to the app after a
// minute (282 requests a week), for a fold that only promotes this install.
describe("the account's onboarding progress", () => {
  const remote = {
    state: {
      flowVersion: 1,
      status: 'completed',
      goal: 'image',
      usernameCompletedAt: null,
      rewardClaimedAt: null,
      completedAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    },
  };

  it('is read once a launch, after the install state, and not again on a return to the app', async () => {
    authState.api.getOnboardingState.mockResolvedValue(remote);
    onboardingState.isHydrated = false;
    const sync = renderSync();
    expect(authState.api.getOnboardingState).not.toHaveBeenCalled();

    onboardingState.isHydrated = true;
    sync.update();
    // The answer, React Query's notice of it on a zero timer, and the fold it brings.
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(authState.api.getOnboardingState).toHaveBeenCalledTimes(1);
    expect(onboardingState.reconcileFromServer).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
    try {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      focusManager.setFocused(undefined);
      later.mockRestore();
    }
    expect(authState.api.getOnboardingState).toHaveBeenCalledTimes(1);
  });

  it('is not read by an install that has finished onboarding, which it could only promote', () => {
    onboardingState.state = { identityDeferredAt: null, status: 'completed', completedAt: '2026-10-01T09:00:00.000Z' };
    renderSync();
    expect(authState.api.getOnboardingState).not.toHaveBeenCalled();
  });
});
