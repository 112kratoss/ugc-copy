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
const MAYA = vi.hoisted(() => ({
  id: 'user-123',
  email: 'maya.k@example.com',
  is_anonymous: false as boolean,
  user_metadata: { full_name: 'Maya Kapoor' } as Record<string, unknown>,
}));
const authState = vi.hoisted(() => ({
  user: { ...MAYA } as typeof MAYA | null,
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
import { AccountDeletingError, ApiError, SessionMergedError } from '../lib/api-client';
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
    authState.user = { ...MAYA, user_metadata: { full_name: 'Maya Kapoor' } };
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

  it('refuses a reserved handle as it is typed, with no request', async () => {
    const tree = mountHost();
    void ask();
    await letTheCheckAnswer();
    authState.api.validateProfile.mockClear();

    act(() => field(tree.root, 'Handle, required').props.onChangeText('support'));
    expect(collectText(tree.root)).toContain('That handle is reserved.');
    await letTheCheckAnswer();
    expect(collectText(tree.root)).toContain('That handle is reserved.');
    expect(authState.api.validateProfile).not.toHaveBeenCalled();
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

  // The proxy's two 409s name no field: they refuse the session, whatever the
  // handle, and the app's handler for each ends it. The handler does not run
  // here, so the sheet stays to show what it said; in the app the session's
  // end then puts the sheet away (the account tests below).
  it.each([
    ['a guest session linked to an account', new SessionMergedError(
      'This guest session has been linked to an account. Sign in to continue.',
      { error: 'This guest session has been linked to an account. Sign in to continue.', code: 'SESSION_MERGED' },
    )],
    ['an account being deleted', new AccountDeletingError(
      'This account is being permanently deleted.',
      { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' },
    )],
  ])('says a save refused for %s above the fields, not against the handle', async (_why, refusal) => {
    authState.api.updateProfile.mockRejectedValue(refusal);
    const tree = mountHost();
    void ask();
    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));
    await letTheCheckAnswer();

    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
    });

    const text = collectText(tree.root);
    // Above the fields, in the server's words; the handle's line still says
    // what the check found.
    expect(text).toContain(refusal.message);
    expect(text).toContain('This handle is available.');
    expect(text.indexOf(refusal.message)).toBeLessThan(text.indexOf('This handle is available.'));
  });

  it('says what is missing at the press, and saves nothing', async () => {
    authState.user = { ...MAYA, user_metadata: {} };
    const tree = mountHost();
    void ask();
    act(() => field(tree.root, 'Display name, required').props.onChangeText(''));

    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
    });

    expect(collectText(tree.root)).toContain('Add a display name for your public profile.');
    expect(authState.api.updateProfile).not.toHaveBeenCalled();
  });

  it('is answered "cancelled" by Cancel, for a second question asked while it is up too', async () => {
    const tree = mountHost();

    const first = ask();
    const second = ask();
    const settled = vi.fn();
    void first.then(settled);
    await act(async () => undefined);
    expect(settled).not.toHaveBeenCalled();

    act(() => button(tree.root, 'Cancel').props.onPress());
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    expect(authState.api.updateProfile).not.toHaveBeenCalled();
  });

  // A 409 ACCOUNT_DELETING ends the session while the sheet is up (the
  // account's deletion was asked for on another device), and the device goes
  // on as a guest, for whom `useAuth` has no user. The answer would be saved
  // to nobody's profile.
  it('is answered "cancelled" when the account it asks for is signed out', async () => {
    const tree = mountHost();
    const answer = ask();

    authState.user = null;
    act(() => tree.update(<PublicIdentitySheetHost />));

    await expect(answer).resolves.toEqual({ status: 'cancelled' });
    expect(authState.api.updateProfile).not.toHaveBeenCalled();
  });

  it('is answered "cancelled" when another account is signed in meanwhile', async () => {
    const tree = mountHost();
    const answer = ask();

    authState.user = { ...MAYA, id: 'user-456' };
    act(() => tree.update(<PublicIdentitySheetHost />));

    await expect(answer).resolves.toEqual({ status: 'cancelled' });
  });

  it('answers "cancelled" at once when asked after the session has ended', async () => {
    authState.user = null;
    const tree = mountHost();

    await expect(ask()).resolves.toEqual({ status: 'cancelled' });
    expect(collectText(tree.root)).not.toContain('Add your name and handle');
  });

  // The usual shape of the deletion: the sheet's own save is refused with the
  // 409, and the teardown ends the session while that save is still out.
  it('is put away once by a session that ends during its save, and the late refusal changes nothing', async () => {
    let refuseSave: (error: unknown) => void = () => undefined;
    authState.api.updateProfile.mockImplementation(() => new Promise((_resolve, reject) => {
      refuseSave = reject;
    }));
    const tree = mountHost();
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);
    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));
    await letTheCheckAnswer();
    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authState.api.updateProfile).toHaveBeenCalledTimes(1);

    authState.user = null;
    act(() => tree.update(<PublicIdentitySheetHost />));
    await expect(answer).resolves.toEqual({ status: 'cancelled' });

    await act(async () => {
      refuseSave(new AccountDeletingError(
        'This account is being permanently deleted.',
        { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' },
      ));
      await Promise.resolve();
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(collectText(tree.root)).not.toContain('Add your name and handle');
  });

  it('stays up when the session is only refreshed for the same account', async () => {
    const tree = mountHost();
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);

    authState.user = { ...MAYA, user_metadata: { full_name: 'Maya Kapoor', refreshed: true } };
    act(() => tree.update(<PublicIdentitySheetHost />));
    await act(async () => undefined);

    expect(settled).not.toHaveBeenCalled();
    expect(button(tree.root, 'Save and make public')).toBeTruthy();
  });

  it('lets a second question wait on the one that is up, and saves once for both', async () => {
    const tree = mountHost();
    const first = ask();
    const second = ask();
    await letTheCheckAnswer();

    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));
    await act(async () => {
      button(tree.root, 'Save and make public').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const saved = { status: 'saved', profile: expect.objectContaining({ username: 'maya-k', displayName: 'Maya Kapoor' }) };
    await expect(first).resolves.toEqual(saved);
    await expect(second).resolves.toEqual(saved);
    expect(authState.api.updateProfile).toHaveBeenCalledTimes(1);
  });

  it('does not ask about the same handle again when only the name changes', async () => {
    const tree = mountHost();
    void ask();
    await letTheCheckAnswer();
    expect(authState.api.validateProfile).toHaveBeenCalledTimes(1);

    act(() => field(tree.root, 'Display name, required').props.onChangeText('Maya K'));
    expect(collectText(tree.root)).toContain('That username is already taken.');
    await letTheCheckAnswer();
    expect(authState.api.validateProfile).toHaveBeenCalledTimes(1);

    // A new handle is asked about with the name as it stands.
    act(() => field(tree.root, 'Handle, required').props.onChangeText('maya-k'));
    await letTheCheckAnswer();
    expect(authState.api.validateProfile).toHaveBeenLastCalledWith({ username: 'maya-k', displayName: 'Maya K' });
  });

  it('answers "unavailable" at once when no sheet is mounted', async () => {
    await expect(requestPublicIdentity()).resolves.toEqual({ status: 'unavailable' });
  });
});
