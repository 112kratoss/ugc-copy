import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstallOnboardingState } from '../lib/onboarding-state';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  api: {
    getProfile: vi.fn(),
    getWelcomeCredits: vi.fn(),
    updateOnboardingState: vi.fn(),
  },
  user: {
    id: 'creator-1',
    email: 'sarath@example.com',
    user_metadata: { full_name: 'Sarath' },
  },
  refreshProfile: vi.fn(),
  updateCredits: vi.fn(),
  localUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: (props: MockProps) => React.createElement('stack-screen', props) },
  router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
  }
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
    Animated: {
      Value,
      View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
      sequence: vi.fn(() => ({ start: vi.fn() })),
      spring: vi.fn(() => ({ start: vi.fn() })),
    },
    ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  AtSign: (props: MockProps) => React.createElement('at-sign', props),
  Clapperboard: (props: MockProps) => React.createElement('clapperboard', props),
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles', props),
  WandSparkles: (props: MockProps) => React.createElement('wand-sparkles', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    api: harness.api,
    user: harness.user,
    refreshProfile: harness.refreshProfile,
    updateCredits: harness.updateCredits,
  }),
}));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));

vi.mock('@/lib/onboarding', async () => {
  const ReactModule = await import('react');
  const initialState: InstallOnboardingState = {
    flowVersion: 1,
    status: 'skipped',
    introStep: 0,
    goal: 'image',
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    identityDeferredAt: null,
  };

  return {
    trackOnboardingEvent: vi.fn(),
    useOnboarding: () => {
      const [state, setState] = ReactModule.useState(initialState);
      const stateRef = ReactModule.useRef(initialState);
      const update = ReactModule.useCallback(async (value: Partial<InstallOnboardingState>) => {
        harness.localUpdates.push(value);
        const next = {
          ...stateRef.current,
          ...value,
          updatedAt: '2026-09-01T10:00:00.000Z',
        };
        stateRef.current = next;
        setState(next);
        return next;
      }, []);
      return {
        state,
        update,
        skip: () => update({ status: 'skipped' }),
        complete: () => update({ status: 'completed' }),
      };
    },
  };
});

vi.mock('@/lib/haptics', () => ({
  haptic: { light: vi.fn(), success: vi.fn() },
}));

vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children, ...props }: MockProps) => React.createElement('keyboard-area', props, children),
}));

vi.mock('@/components/onboarding-booklet', () => ({
  OnboardingBookletGoal: (props: MockProps) => React.createElement('onboarding-goal', props),
}));

vi.mock('@/components/onboarding-header', () => ({
  OnboardingHeader: (props: MockProps) => React.createElement('onboarding-header', props),
}));

vi.mock('@/components/onboarding-welcome', () => ({
  OnboardingWelcome: (props: MockProps) => React.createElement('onboarding-welcome', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  AppTextInput: (props: MockProps) => React.createElement('app-text-input', props),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('kicker', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
}));

import OnboardingScreen from '../app/onboarding';

const profile = {
  username: 'creator-1234abcd',
  displayName: 'Sarath',
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
};

const welcome = {
  status: 'not_eligible',
  identityComplete: false,
  amount: 25,
  promotionalAmount: 25,
  credits: 0,
  promotionalCredits: 0,
  claimedAt: null,
};

describe('authenticated onboarding entry', () => {
  beforeEach(() => {
    harness.api.getProfile.mockReset();
    harness.api.getWelcomeCredits.mockReset();
    harness.api.updateOnboardingState.mockReset();
    harness.api.updateOnboardingState.mockResolvedValue(undefined);
    harness.localUpdates.length = 0;
  });

  it('loads account state once when a skipped guest resumes after signing in', async () => {
    const never = new Promise<never>(() => undefined);
    harness.api.getProfile.mockResolvedValueOnce(profile).mockReturnValue(never);
    harness.api.getWelcomeCredits.mockResolvedValueOnce(welcome).mockReturnValue(never);

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<OnboardingScreen />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.api.getProfile).toHaveBeenCalledTimes(1);
    expect(harness.api.getWelcomeCredits).toHaveBeenCalledTimes(1);
    expect(harness.localUpdates).toEqual([{ goal: 'image' }]);
    expect(JSON.stringify(tree?.toJSON())).toContain('Claim your creator name');
    expect(JSON.stringify(tree?.toJSON())).not.toContain('Preparing your creator setup');

    act(() => tree?.unmount());
  });
});
