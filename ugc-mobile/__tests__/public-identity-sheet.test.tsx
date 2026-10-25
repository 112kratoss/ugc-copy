// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const keyboardState = vi.hoisted(() => ({ dismiss: vi.fn() }));
const placeholderProfile = vi.hoisted(() => ({
  id: 'user-123',
  username: 'creator-a1b2c3d4',
  suggestedUsername: 'creator-a1b2c3d4',
  displayName: null as string | null,
}));
const profileState = vi.hoisted(() => ({ profile: null as Record<string, unknown> | null }));
const queryClientState = vi.hoisted(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }));
const welcomeCreditsState = vi.hoisted(() => ({ invalidate: vi.fn(async () => undefined) }));
const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'maya.k@example.com', user_metadata: { full_name: 'Maya Kapoor' } as Record<string, unknown> },
  refreshProfile: vi.fn(async () => undefined),
  api: {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    validateProfile: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    Value: class {
      constructor(public value: number) {}

      setValue(next: number) {
        this.value = next;
      }

      stopAnimation() {}

      interpolate(config: unknown) {
        return { interpolate: config };
      }
    },
    add: (a: unknown, b: unknown) => ({ add: [a, b] }),
    multiply: (a: unknown, b: unknown) => ({ multiply: [a, b] }),
    timing: () => ({
      start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      stop: () => undefined,
    }),
    spring: () => ({
      start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      stop: () => undefined,
    }),
  },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, cubic: 'cubic' },
  Keyboard: keyboardState,
  PanResponder: { create: (handlers: Record<string, unknown>) => ({ panHandlers: handlers }) },
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios || obj.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
    'pressable',
    { ...props, style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style },
    children,
  ),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClientState,
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === 'profile'
    ? { data: profileState.profile, error: null, isLoading: false, isSuccess: Boolean(profileState.profile) }
    : { data: null, error: null, isLoading: false, isSuccess: false }),
}));
// `components/ui.tsx` draws its web links through expo-router's Link.
vi.mock('expo-router', () => ({ Link: ({ children }: MockProps) => children, router: { push: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
// The module's real imports reach expo-crypto, which reads __DEV__ as it loads.
vi.mock('@/lib/use-onboarding-destination', () => ({ invalidateWelcomeCredits: welcomeCreditsState.invalidate }));

import { PublicIdentitySheetHost } from '../components/public-identity-sheet';
import { ApiError } from '../lib/api-client';
import { requestPublicIdentity, type PublicIdentityOutcome } from '../lib/public-identity-prompt';
import { HANDLE_CHECK_DELAY_MS } from '../lib/use-handle-availability';

function collectText(root: renderer.ReactTestInstance) {
  return root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function field(root: renderer.ReactTestInstance, label: string) {
  const input = root.findAll((node) => String(node.type) === 'textinput' && node.props.accessibilityLabel === label)[0];
  if (!input) throw new Error(`No text input labelled "${label}"`);
  return input;
}

function button(root: renderer.ReactTestInstance, label: string) {
  const pressable = root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
  if (!pressable) throw new Error(`No button labelled "${label}"`);
  return pressable;
}

const mounted: renderer.ReactTestRenderer[] = [];

function mountHost() {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<PublicIdentitySheetHost />);
  });
  mounted.push(tree);
  return tree;
}

function ask() {
  let answer!: Promise<PublicIdentityOutcome>;
  act(() => {
    answer = requestPublicIdentity();
  });
  return answer;
}

/** Lets the handle check's pause run out and its answer arrive. */
async function letTheCheckAnswer() {
  await act(async () => {
    vi.advanceTimersByTime(HANDLE_CHECK_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const taken = new ApiError('That username is already taken.', 409, {
  error: 'That username is already taken.',
  fieldErrors: { username: 'That username is already taken.' },
});

describe('the sheet a list opens to ask for a name and handle before a post goes public', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authState.user.user_metadata = { full_name: 'Maya Kapoor' };
    profileState.profile = { ...placeholderProfile };
    authState.api.getProfile.mockReset();
    authState.api.getProfile.mockImplementation(async () => profileState.profile);
    authState.api.updateProfile.mockReset();
    authState.api.updateProfile.mockImplementation(async (body: Record<string, unknown>) => ({ ...placeholderProfile, ...body }));
    authState.api.validateProfile.mockReset();
    authState.api.validateProfile.mockImplementation(async (body: { username?: string }) => {
      if (body.username === 'maya-kapoor') throw taken;
      return { ok: true };
    });
    authState.refreshProfile.mockClear();
    queryClientState.setQueryData.mockClear();
    welcomeCreditsState.invalidate.mockClear();
    keyboardState.dismiss.mockClear();
  });

  afterEach(() => {
    act(() => {
      for (const tree of mounted.splice(0)) tree.unmount();
    });
    vi.useRealTimers();
  });

  it('asks with the fields filled from the profile and the sign-in, the page\'s keyboard put away', () => {
    const tree = mountHost();
    void ask();

    expect(collectText(tree.root)).toContain('Add your name and handle');
    expect(field(tree.root, 'Display name, required').props.value).toBe('Maya Kapoor');
    expect(field(tree.root, 'Handle, required').props.value).toBe('maya-kapoor');
    expect(keyboardState.dismiss).toHaveBeenCalled();
  });

  it('says a taken handle beside the field as it is typed, and an available one too', async () => {
    const tree = mountHost();
    void ask();

    // The suggestion is someone else's: said before any press.
    expect(collectText(tree.root)).toContain('Checking availability…');
    await letTheCheckAnswer();
    expect(collectText(tree.root)).toContain('That username is already taken.');
    expect(authState.api.validateProfile).toHaveBeenCalledWith({ username: 'maya-kapoor', displayName: 'Maya Kapoor' });

    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));
    expect(collectText(tree.root)).toContain('Checking availability…');
    await letTheCheckAnswer();
    expect(collectText(tree.root)).toContain('This handle is available.');
    expect(collectText(tree.root)).not.toContain('That username is already taken.');
  });

  it('saves both with the composer\'s claim and answers with the saved profile', async () => {
    const tree = mountHost();
    const answer = ask();
    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));

    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
    });

    await expect(answer).resolves.toEqual({
      status: 'saved',
      profile: expect.objectContaining({ username: 'maya-k', displayName: 'Maya Kapoor' }),
    });
    // Read again first, then saved: the claim the composer makes.
    expect(authState.api.getProfile).toHaveBeenCalled();
    expect(authState.api.updateProfile).toHaveBeenCalledWith({ username: 'maya-k', displayName: 'Maya Kapoor' });
    const [key, update] = queryClientState.setQueryData.mock.calls.at(-1) as [unknown, (cached: unknown) => unknown];
    expect(key).toEqual(['profile', 'user-123']);
    expect(update({ ...placeholderProfile, stats: { posts: 3 } }))
      .toEqual(expect.objectContaining({ username: 'maya-k', displayName: 'Maya Kapoor', stats: { posts: 3 } }));
    expect(welcomeCreditsState.invalidate).toHaveBeenCalledWith(queryClientState);
    expect(authState.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it('stays open with the refusal on the handle when the save finds it taken', async () => {
    authState.api.updateProfile.mockRejectedValue(taken);
    const tree = mountHost();
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);
    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya'));

    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
    });

    expect(collectText(tree.root)).toContain('That username is already taken.');
    expect(collectText(tree.root)).toContain('Add your name and handle');
    expect(settled).not.toHaveBeenCalled();
    expect(field(tree.root, 'Handle, required').props.editable).toBe(true);
  });

  it('says what is missing at the press, and saves nothing', async () => {
    authState.user.user_metadata = {};
    const tree = mountHost();
    void ask();
    act(() => field(tree.root, 'Display name, required').props.onChangeText(''));

    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
    });

    expect(collectText(tree.root)).toContain('Add a display name for your public profile.');
    expect(authState.api.updateProfile).not.toHaveBeenCalled();
  });

  it('is answered "cancelled" by Cancel, and a second question answers the first', async () => {
    const tree = mountHost();

    const first = ask();
    const second = ask();
    await expect(first).resolves.toEqual({ status: 'cancelled' });

    act(() => button(tree.root, 'Cancel').props.onPress());
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    expect(authState.api.updateProfile).not.toHaveBeenCalled();
  });

  it('answers "unavailable" at once when no sheet is mounted', async () => {
    await expect(requestPublicIdentity()).resolves.toEqual({ status: 'unavailable' });
  });
});
