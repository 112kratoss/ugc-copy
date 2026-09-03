// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WelcomeCreditResponse } from '../lib/types';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const authState = vi.hoisted(() => ({
  api: { getWelcomeCredits: vi.fn() },
  user: { id: 'creator-1' } as { id: string } | null,
  isLoading: false,
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
}));

vi.mock('react-native', () => ({
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return { ArrowRight: icon('ArrowRight'), Gift: icon('Gift'), Sparkles: icon('Sparkles') };
});

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('kicker', props, children),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/haptics', () => ({
  haptic: { light: vi.fn() },
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  usePressMotion: () => ({ animatedStyle: {}, onPressIn: vi.fn(), onPressOut: vi.fn() }),
}));

vi.mock('@/lib/onboarding', () => ({
  useOnboarding: () => ({ state: { identityDeferredAt: null } }),
}));

import { OnboardingResumeCard } from '../components/onboarding-resume-card';
import { primeWelcomeCredits, welcomeCreditsQueryKey } from '../lib/use-onboarding-destination';

const welcomeAtSignIn: WelcomeCreditResponse = {
  programKey: 'welcome_credits_v1',
  status: 'not_eligible',
  amount: 25,
  promotionalAmount: 25,
  credits: 0,
  promotionalCredits: 0,
  claimedAt: null,
  identityComplete: false,
};

function renderCard(queryClient: QueryClient) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <QueryClientProvider client={queryClient}>
        <OnboardingResumeCard compact />
      </QueryClientProvider>,
    );
  });
  return tree;
}

const rendered = (tree: renderer.ReactTestRenderer) => JSON.stringify(tree.toJSON());

describe('the creator-setup card', () => {
  beforeEach(() => {
    authState.user = { id: 'creator-1' };
    authState.isLoading = false;
    authState.api.getWelcomeCredits.mockReset();
    // Never resolves: the card must live off the shared cache in these tests,
    // so a request that answered would hide a card that ignored the cache.
    authState.api.getWelcomeCredits.mockReturnValue(new Promise<never>(() => undefined));
  });

  it('follows the shared welcome query the moment a screen primes it', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(welcomeCreditsQueryKey('creator-1'), welcomeAtSignIn);
    const tree = renderCard(queryClient);
    expect(rendered(tree)).toContain('Finish your creator setup');

    // What the onboarding screen learns after the handle is saved. Before the
    // cache was seeded the card kept the sign-in answer above and re-offered a
    // flow that had nothing left to show.
    await act(async () => {
      primeWelcomeCredits(queryClient, 'creator-1', {
        ...welcomeAtSignIn,
        status: 'identity_already_claimed',
        identityComplete: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(tree.toJSON()).toBeNull();

    act(() => tree.unmount());
  });

  it('waits for the session before offering the guest intro', () => {
    authState.user = null;
    authState.isLoading = true;
    const tree = renderCard(new QueryClient());
    expect(tree.toJSON()).toBeNull();
    act(() => tree.unmount());
  });

  it('offers the intro once a signed-out session has settled', () => {
    authState.user = null;
    authState.isLoading = false;
    const tree = renderCard(new QueryClient());
    expect(rendered(tree)).toContain('See the new creator setup');
    act(() => tree.unmount());
  });
});
