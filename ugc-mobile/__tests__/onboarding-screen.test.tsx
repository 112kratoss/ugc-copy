import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstallOnboardingState } from '../lib/onboarding-state';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  api: {
    getProfile: vi.fn(),
    getWelcomeCredits: vi.fn(),
    updateOnboardingState: vi.fn(),
    validateProfile: vi.fn(),
    updateProfile: vi.fn(),
    claimWelcomeCredits: vi.fn(),
  },
  user: {
    id: 'creator-1',
    email: 'sarath@example.com',
    user_metadata: { full_name: 'Sarath' } as Record<string, unknown>,
  },
  refreshProfile: vi.fn(),
  updateCredits: vi.fn(),
  markIdentityDeferredOnAccount: vi.fn(),
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
    markIdentityDeferredOnAccount: harness.markIdentityDeferredOnAccount,
  }),
}));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
// The first run is drawn dark and raises its own light status bar while it is in front.
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

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
import { ApiError } from '../lib/api-client';
import { HANDLE_CHECK_DELAY_MS } from '../lib/use-handle-availability';
import { welcomeCreditsQueryKey } from '../lib/use-onboarding-destination';

function renderScreen(queryClient: QueryClient) {
  return renderer.create(
    <QueryClientProvider client={queryClient}>
      <OnboardingScreen />
    </QueryClientProvider>,
  );
}

async function settle() {
  // Enough microtasks for the profile + welcome fetch, the destination
  // resolution, and the state writes that follow it.
  for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
}

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
    vi.mocked(router.replace).mockClear();
  });

  it('loads account state once when a skipped guest resumes after signing in', async () => {
    const never = new Promise<never>(() => undefined);
    harness.api.getProfile.mockResolvedValueOnce(profile).mockReturnValue(never);
    harness.api.getWelcomeCredits.mockResolvedValueOnce(welcome).mockReturnValue(never);

    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    expect(harness.api.getProfile).toHaveBeenCalledTimes(1);
    expect(harness.api.getWelcomeCredits).toHaveBeenCalledTimes(1);
    expect(harness.localUpdates).toEqual([{ goal: 'image' }]);
    expect(JSON.stringify(tree?.toJSON())).toContain('Claim your creator name');
    expect(JSON.stringify(tree?.toJSON())).not.toContain('Preparing your creator setup');
    // The Home card reads this key. Seeding it here is what keeps the card
    // and this screen telling the same story.
    expect(queryClient.getQueryData(welcomeCreditsQueryKey('creator-1'))).toEqual(welcome);

    act(() => tree?.unmount());
  });

  it('writes what it learned into the shared welcome query before leaving', async () => {
    // The reported loop: the card kept the welcome response it took at
    // sign-in (identity incomplete), so it still read "Finish your creator
    // setup" after the handle was saved. Tapping it re-entered this screen,
    // which fetched the truth, found nothing to do, and bounced straight out —
    // and the card stayed until an unrelated refetch happened to land.
    const settled = { ...welcome, status: 'identity_already_claimed', identityComplete: true };
    harness.api.getProfile.mockResolvedValue({ ...profile, username: 'tap', displayName: 'Kannan' });
    harness.api.getWelcomeCredits.mockResolvedValue(settled);
    const queryClient = new QueryClient();
    queryClient.setQueryData(welcomeCreditsQueryKey('creator-1'), welcome);

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(queryClient.getQueryData(welcomeCreditsQueryKey('creator-1'))).toEqual(settled);

    act(() => tree?.unmount());
  });
});

describe('claiming a creator name', () => {
  beforeEach(() => {
    harness.api.getProfile.mockReset().mockResolvedValue(profile);
    harness.api.getWelcomeCredits.mockReset().mockResolvedValue(welcome);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.api.validateProfile.mockReset().mockResolvedValue({ ok: true });
    harness.api.updateProfile.mockReset().mockImplementation(async (body: Record<string, unknown>) => ({ ...profile, ...body }));
    harness.localUpdates.length = 0;
  });

  it('sends the handle and the name, and none of the fields this step does not hold', async () => {
    // `PATCH /api/profile` is partial: a key left out keeps the stored value.
    // The step used to echo the bio, photos, links and location it read on
    // entry, which could write over a newer edit, and a `null` among them
    // would clear a field.
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    const handle = tree!.root.find((node) => String(node.type) === 'app-text-input' && node.props.label === 'Unique handle');
    await act(async () => { handle.props.onChangeText('sarath-makes'); });
    const save = tree!.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Save creator name');
    await act(async () => {
      save.props.onPress();
      await settle();
    });

    expect(harness.api.validateProfile).toHaveBeenCalledWith({ username: 'sarath-makes', displayName: 'Sarath' });
    expect(harness.api.updateProfile).toHaveBeenCalledTimes(1);
    expect(harness.api.updateProfile).toHaveBeenCalledWith({ username: 'sarath-makes', displayName: 'Sarath' });

    act(() => tree?.unmount());
  });
});

function findButton(tree: renderer.ReactTestRenderer, type: 'primary-button' | 'secondary-button', label: string) {
  return tree.root.find((node) => String(node.type) === type && node.props.label === label);
}

function rendered(tree: renderer.ReactTestRenderer | undefined) {
  return JSON.stringify(tree?.toJSON());
}

async function saveHandle(tree: renderer.ReactTestRenderer) {
  const handle = tree.root.find((node) => String(node.type) === 'app-text-input' && node.props.label === 'Unique handle');
  await act(async () => { handle.props.onChangeText('sarath-makes'); });
  await act(async () => {
    findButton(tree, 'primary-button', 'Save creator name').props.onPress();
    await settle();
  });
}

describe('checking the handle as it is typed', () => {
  const taken = new ApiError('That username is already taken.', 409, {
    error: 'That username is already taken.',
    fieldErrors: { username: 'That username is already taken.' },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    harness.api.getProfile.mockReset().mockResolvedValue(profile);
    harness.api.getWelcomeCredits.mockReset().mockResolvedValue(welcome);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.api.validateProfile.mockReset().mockImplementation(async (body: { username?: string }) => {
      if (body.username === 'sarath') throw taken;
      return { ok: true };
    });
    harness.localUpdates.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openIdentityStep() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderScreen(new QueryClient());
      await settle();
    });
    return tree;
  }

  async function typeHandle(tree: renderer.ReactTestRenderer, value: string) {
    const handle = tree.root.find((node) => String(node.type) === 'app-text-input' && node.props.label === 'Unique handle');
    await act(async () => { handle.props.onChangeText(value); });
  }

  /** Lets the check's pause run out and its answer arrive. */
  async function letTheCheckAnswer() {
    await act(async () => {
      vi.advanceTimersByTime(HANDLE_CHECK_DELAY_MS);
      await settle();
    });
  }

  function handleLine(tree: renderer.ReactTestRenderer) {
    const line = tree.root.find((node) => String(node.type) === 'app-text' && node.props.accessibilityLiveRegion === 'polite');
    return { text: line.props.children as string, color: line.props.color as string };
  }

  it('says an available handle and a taken one in its own words', async () => {
    const tree = await openIdentityStep();

    await typeHandle(tree, 'sarath-makes');
    expect(handleLine(tree).text).toBe('Checking availability…');
    await letTheCheckAnswer();
    expect(handleLine(tree)).toEqual({ text: 'This creator name is available.', color: 'success' });

    await typeHandle(tree, 'sarath');
    await letTheCheckAnswer();
    expect(handleLine(tree)).toEqual({ text: 'That username is already taken.', color: 'danger' });
    expect(findButton(tree, 'primary-button', 'Save creator name').props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  it.each([
    ['offline', new ApiError('Network request failed. Please check your connection and try again.', 0, { url: 'https://magicbooklet.com/api/profile/validate' })],
    ['rate limited', new ApiError('Too many requests. Try again shortly.', 429)],
  ])('says nothing against the handle when the check fails %s', async (_how, failure) => {
    harness.api.validateProfile.mockRejectedValue(failure);
    const tree = await openIdentityStep();

    await typeHandle(tree, 'sarath-makes');
    await letTheCheckAnswer();

    expect(harness.api.validateProfile).toHaveBeenCalledWith({ username: 'sarath-makes', displayName: 'Sarath' });
    // No verdict on the name: the line goes back to the rule, and the save judges.
    expect(handleLine(tree)).toEqual({ text: '3–24 lowercase letters, numbers, or hyphens.', color: 'muted' });
    expect(findButton(tree, 'primary-button', 'Save creator name').props.disabled).toBe(false);

    act(() => tree.unmount());
  });

  it('says a handle the save found taken until another one is typed', async () => {
    // Free when it was checked, claimed by someone else before the save.
    harness.api.updateProfile.mockReset().mockRejectedValue(taken);
    const tree = await openIdentityStep();

    await typeHandle(tree, 'sarath-makes');
    await letTheCheckAnswer();
    await act(async () => {
      findButton(tree, 'primary-button', 'Save creator name').props.onPress();
      await settle();
    });

    expect(handleLine(tree)).toEqual({ text: 'That handle was just claimed. Try another one.', color: 'danger' });
    expect(findButton(tree, 'primary-button', 'Save creator name').props.disabled).toBe(true);

    await typeHandle(tree, 'sarath-makes-2');
    await letTheCheckAnswer();
    expect(handleLine(tree)).toEqual({ text: 'This creator name is available.', color: 'success' });
    expect(findButton(tree, 'primary-button', 'Save creator name').props.disabled).toBe(false);

    act(() => tree.unmount());
  });

  it('refuses a reserved handle as it is typed, with no request', async () => {
    const tree = await openIdentityStep();

    await typeHandle(tree, 'support');
    await letTheCheckAnswer();

    expect(handleLine(tree)).toEqual({ text: 'That handle is reserved.', color: 'danger' });
    expect(findButton(tree, 'primary-button', 'Save creator name').props.disabled).toBe(true);
    expect(harness.api.validateProfile).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });
});

describe('what the welcome answer after the identity step says (03-6)', () => {
  beforeEach(() => {
    harness.api.getProfile.mockReset().mockResolvedValue(profile);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.api.validateProfile.mockReset().mockResolvedValue({ ok: true });
    harness.api.updateProfile.mockReset().mockImplementation(async (body: Record<string, unknown>) => ({ ...profile, ...body }));
    harness.refreshProfile.mockReset().mockResolvedValue(undefined);
    harness.localUpdates.length = 0;
    vi.mocked(router.replace).mockClear();
  });

  it.each([
    ['identity_already_claimed', 'Welcome credits already claimed', 'This sign-in already received the one-time welcome credits on a previous account.'],
    ['unavailable', 'Welcome credits are unavailable right now', 'Your welcome credits are temporarily unavailable. You can continue and claim them from Home.'],
  ])('says %s before it opens the creator', async (status, title, line) => {
    harness.api.getWelcomeCredits.mockReset()
      .mockResolvedValueOnce(welcome)
      .mockResolvedValue({ ...welcome, status, identityComplete: true });
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    await saveHandle(tree!);

    // Said, and the creator not opened yet: the person reads it first.
    expect(rendered(tree)).toContain(title);
    expect(rendered(tree)).toContain(line);
    expect(router.replace).not.toHaveBeenCalled();
    // No figure and no claim for credits that will not come.
    expect(tree!.root.findAll((node) => String(node.type) === 'primary-button' && String(node.props.label).startsWith('Claim'))).toHaveLength(0);

    await act(async () => {
      findButton(tree!, 'primary-button', 'Start creating').props.onPress();
      await settle();
    });
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(tabs)/creator',
      params: { tool: 'image', guided: '1' },
    });

    act(() => tree?.unmount());
  });

  it('still goes straight on for an account the program never covered', async () => {
    harness.api.getWelcomeCredits.mockReset()
      .mockResolvedValueOnce(welcome)
      .mockResolvedValue({ ...welcome, status: 'legacy_ineligible', identityComplete: true });
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    await saveHandle(tree!);

    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(tabs)/creator',
      params: { tool: 'image', guided: '1' },
    });

    act(() => tree?.unmount());
  });
});

describe('claiming the welcome credits (03-9)', () => {
  const eligible = { ...welcome, status: 'eligible', identityComplete: true };

  beforeEach(() => {
    harness.api.getProfile.mockReset().mockResolvedValue({ ...profile, username: 'sarath-makes' });
    harness.api.getWelcomeCredits.mockReset().mockResolvedValue(eligible);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.api.claimWelcomeCredits.mockReset();
    harness.refreshProfile.mockReset().mockResolvedValue(undefined);
    harness.updateCredits.mockReset();
    harness.localUpdates.length = 0;
  });

  async function claim(result: Record<string, unknown>) {
    harness.api.claimWelcomeCredits.mockResolvedValue(result);
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });
    await act(async () => {
      findButton(tree!, 'primary-button', 'Claim 25 credits').props.onPress();
      await settle();
    });
    return tree!;
  }

  it('takes the balance from a claim made just now', async () => {
    const tree = await claim({ ...eligible, status: 'claimed', credits: 25, claimedAt: '2026-10-15T07:00:00.000Z' });

    expect(harness.updateCredits).toHaveBeenCalledWith(25);
    expect(harness.refreshProfile).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('re-reads the balance for a claim made earlier instead of trusting its stale figure', async () => {
    // Claimed on the web last week; 25 was the balance right after that grant.
    const tree = await claim({ ...eligible, status: 'already_claimed', credits: 25, claimedAt: '2026-10-08T07:00:00.000Z' });

    expect(harness.refreshProfile).toHaveBeenCalledTimes(1);
    expect(harness.updateCredits).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('adds nothing for a sign-in that was paid out on a previous account', async () => {
    const tree = await claim({ ...eligible, status: 'identity_already_claimed' });

    expect(harness.updateCredits).not.toHaveBeenCalled();
    expect(rendered(tree)).toContain('Welcome credits already claimed');
    act(() => tree.unmount());
  });
});

describe('choosing a name later (02-11)', () => {
  beforeEach(() => {
    harness.api.getProfile.mockReset().mockResolvedValue(profile);
    harness.api.getWelcomeCredits.mockReset().mockResolvedValue(welcome);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.markIdentityDeferredOnAccount.mockReset().mockResolvedValue(undefined);
    harness.localUpdates.length = 0;
    vi.mocked(router.replace).mockClear();
  });

  it('records the deferral on the account as well as on this install', async () => {
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    await act(async () => {
      findButton(tree!, 'secondary-button', 'Choose a name later').props.onPress();
      await settle();
    });

    expect(harness.markIdentityDeferredOnAccount).toHaveBeenCalledTimes(1);
    expect(harness.localUpdates).toContainEqual(expect.objectContaining({
      status: 'skipped',
      identityDeferredAt: expect.any(String),
    }));
    expect(router.replace).toHaveBeenCalledWith('/(tabs)');

    act(() => tree?.unmount());
  });

  it('leaves even when the account write fails', async () => {
    harness.markIdentityDeferredOnAccount.mockRejectedValue(new Error('Network request failed'));
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    await act(async () => {
      findButton(tree!, 'secondary-button', 'Choose a name later').props.onPress();
      await settle();
    });

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    act(() => tree?.unmount());
  });

  it('does not write it for the other ways out', async () => {
    harness.api.getProfile.mockReset().mockRejectedValue(new Error('Server error'));
    const queryClient = new QueryClient();
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderScreen(queryClient);
      await settle();
    });

    await act(async () => {
      findButton(tree!, 'secondary-button', 'Skip for now').props.onPress();
      await settle();
    });

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(harness.markIdentityDeferredOnAccount).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });
});

describe('a deferral made on the web (02-11)', () => {
  beforeEach(() => {
    harness.api.getProfile.mockReset().mockResolvedValue(profile);
    harness.api.getWelcomeCredits.mockReset().mockResolvedValue(welcome);
    harness.api.updateOnboardingState.mockReset().mockResolvedValue(undefined);
    harness.localUpdates.length = 0;
    vi.mocked(router.replace).mockClear();
  });

  it('is not asked for a handle again on the phone', async () => {
    harness.user.user_metadata = { full_name: 'Sarath', creator_profile_onboarding_skipped_version: 1 };
    try {
      const queryClient = new QueryClient();
      let tree: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        tree = renderScreen(queryClient);
        await settle();
      });

      expect(router.replace).toHaveBeenCalledWith('/(tabs)');
      expect(JSON.stringify(tree?.toJSON())).not.toContain('Claim your creator name');
      act(() => tree?.unmount());
    } finally {
      harness.user.user_metadata = { full_name: 'Sarath' };
    }
  });
});
