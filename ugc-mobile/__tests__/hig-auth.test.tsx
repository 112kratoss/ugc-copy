import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appTheme } from '../lib/theme';
import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
import {
  GENERIC_SIGN_IN_FAILURE,
  describePasswordSignInError,
  describeProviderSignInError,
  validateCredentials,
} from '../lib/auth-error-copy';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const platformState = vi.hoisted(() => ({ os: 'ios' }));

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  signInWithPassword: vi.fn(),
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
  isAuthConfigured: true,
  missingEnvKeys: [] as string[],
}));

vi.mock('expo-router', () => ({
  router: { canGoBack: vi.fn(() => false), back: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({}),
  Link: (props: MockProps) => React.createElement('link', props),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: (props: MockProps) => React.createElement('apple-authentication-button', props),
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE' },
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', SIGN_UP: 'SIGN_UP' },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Image: (props: MockProps) => React.createElement('image', props),
  Linking: { openURL: vi.fn() },
  Platform: {
    get OS() {
      return platformState.os;
    },
    select: (obj: Record<string, unknown>) => obj[platformState.os] || obj.default,
  },
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', { ...props, style: resolvePressableStyle(style) }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowLeft: (props: MockProps) => React.createElement('arrow-left-icon', props),
  ChevronLeft: (props: MockProps) => React.createElement('chevron-left-icon', props),
  Eye: (props: MockProps) => React.createElement('eye-icon', props),
  EyeOff: (props: MockProps) => React.createElement('eye-off-icon', props),
  LockKeyhole: (props: MockProps) => React.createElement('lock-icon', props),
  Mail: (props: MockProps) => React.createElement('mail-icon', props),
  Share: (props: MockProps) => React.createElement('share-icon', props),
  Share2: (props: MockProps) => React.createElement('share2-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/apple-auth', () => ({ isAppleAuthCanceled: () => false }));
vi.mock('@/lib/google-auth', () => ({ isGoogleAuthCanceled: () => false }));

import AuthScreen from '../app/auth';

const authSource = readFileSync('app/auth.tsx', 'utf8');

function render() {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<AuthScreen />);
  });
  return tree!;
}

function type(tree: renderer.ReactTestRenderer, field: 'Email' | 'Password', value: string) {
  renderer.act(() => {
    tree.root.findByProps({ accessibilityLabel: field }).props.onChangeText(value);
  });
}

async function submit(tree: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    tree.root.findByProps({ accessibilityLabel: 'Sign in', accessibilityRole: 'button' }).props.onPress();
  });
}

/**
 * Host elements only. `findAllByProps` also returns the composite instance for
 * every mocked component, whose `style` is still the unresolved function the
 * real Pressable would call — asking it for a height gets `undefined`.
 */
function hosts(tree: renderer.ReactTestRenderer, props: Record<string, unknown>) {
  return tree.root.findAllByProps(props).filter((node) => typeof node.type === 'string');
}

function styleOf(tree: renderer.ReactTestRenderer, props: Record<string, unknown>) {
  const [host] = hosts(tree, props);
  return (host?.props.style ?? {}) as Record<string, number | string>;
}

function alerts(tree: renderer.ReactTestRenderer) {
  return hosts(tree, { accessibilityRole: 'alert' });
}

beforeEach(() => {
  platformState.os = 'ios';
  authState.user = null;
  authState.isAuthConfigured = true;
  authState.missingEnvKeys = [];
  authState.signInWithPassword.mockReset();
  authState.signInWithPassword.mockResolvedValue(undefined);
  authState.signInWithApple.mockReset();
  authState.signInWithApple.mockResolvedValue(undefined);
  authState.signInWithGoogle.mockReset();
  authState.signInWithGoogle.mockResolvedValue(undefined);
});

describe('S2 — the sign-in buttons are the same size', () => {
  it('gives the Apple button the height of the screen\'s own primary button', () => {
    const tree = render();
    // Sign in with Apple: "Make a Sign in with Apple button no smaller than
    // other sign-in buttons."
    expect(styleOf(tree, { accessibilityLabel: 'Sign in with Apple' }).height).toBe(appTheme.touch.roomy);
    expect(styleOf(tree, { accessibilityLabel: 'Sign in', accessibilityRole: 'button' }).minHeight)
      .toBe(appTheme.touch.roomy);
  });

  it('gives the Google button the same height, scaled on its own aspect', () => {
    platformState.os = 'android';
    const tree = render();
    expect(styleOf(tree, { accessibilityLabel: 'Sign in with Google' }).minHeight).toBe(appTheme.touch.roomy);
    const [artwork] = hosts(tree, { accessibilityIgnoresInvertColors: true });
    const { width, height } = artwork.props.style as { width: number; height: number };
    expect(height).toBe(appTheme.touch.roomy);
    // Google's artwork ships at 216x48; distorting it is not allowed.
    expect(width / height).toBeCloseTo(216 / 48, 5);
  });
});

describe('S2 — sign-up is not dressed as a failure', () => {
  it('shows no alert when a configured app opens the sign-up tab', () => {
    const tree = render();
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    expect(alerts(tree)).toHaveLength(0);
    expect(hosts(tree, { accessibilityLabel: 'Sign up with Apple' })).toHaveLength(1);
  });

  it('says how to sign up in the subtitle, naming only the method on screen', () => {
    const tree = render();
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    const copy = JSON.stringify(tree.toJSON());
    expect(copy).toContain('New accounts are created with Apple.');
    expect(copy).not.toContain('with Google');
  });

  it('keeps the alert for a genuine misconfiguration', () => {
    authState.isAuthConfigured = false;
    authState.missingEnvKeys = ['EXPO_PUBLIC_SUPABASE_URL'];

    expect(alerts(render())).toHaveLength(1);
  });

  it('offers the divider only where there is an alternative to continue from', () => {
    const tree = render();
    expect(JSON.stringify(tree.toJSON())).toContain('or continue with');

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });
    expect(JSON.stringify(tree.toJSON())).not.toContain('or continue with');
  });
});

describe('S2 — a failure is told in the app\'s words, where it can be seen', () => {
  it('never repeats the provider message', () => {
    expect(describePasswordSignInError(new Error('Invalid login credentials')).title)
      .toBe('That email and password do not match');
    expect(describePasswordSignInError(new Error('Email not confirmed')).title)
      .toBe('Confirm your email first');
    expect(describePasswordSignInError(new Error('AuthApiError: pgrst116 boom')))
      .toEqual(GENERIC_SIGN_IN_FAILURE);
    expect(describeProviderSignInError(new Error('nonce mismatch'), 'Apple').title)
      .toBe('Could not finish with Apple');
  });

  it('renders the failure inline rather than as a floating toast', async () => {
    authState.signInWithPassword.mockRejectedValue(new Error('Invalid login credentials'));
    const tree = render();
    type(tree, 'Email', 'creator@example.com');
    type(tree, 'Password', 'correcthorse');
    await submit(tree);

    const [alert] = alerts(tree);
    expect(alert).toBeTruthy();
    expect(JSON.stringify(tree.toJSON())).toContain('That email and password do not match');
    // The password field's Return key submits with the keyboard up, so an error
    // pinned to the bottom of the screen would appear behind it.
    expect(authSource).not.toContain("position: 'absolute'");
    expect(alert.props.accessibilityLiveRegion).toBe('assertive');
  });

  it('clears the failure as soon as the person edits the field', async () => {
    authState.signInWithPassword.mockRejectedValue(new Error('Invalid login credentials'));
    const tree = render();
    type(tree, 'Email', 'creator@example.com');
    type(tree, 'Password', 'correcthorse');
    await submit(tree);
    expect(alerts(tree)).toHaveLength(1);

    type(tree, 'Email', 'creator@example.co');
    expect(alerts(tree)).toHaveLength(0);
  });
});

describe('S2 — a typo costs a glance, not a round trip', () => {
  it('names the problem without calling the API', async () => {
    const tree = render();
    type(tree, 'Email', 'nobody2example');
    type(tree, 'Password', 'correcthorse');
    await submit(tree);

    expect(authState.signInWithPassword).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('Check the email address');
  });

  it('names a short password rather than disabling the button silently', async () => {
    const tree = render();
    type(tree, 'Email', 'creator@example.com');
    type(tree, 'Password', 'abc');
    await submit(tree);

    expect(authState.signInWithPassword).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('Password is too short');
  });

  it('enables the button as soon as both fields have something in them', () => {
    const tree = render();
    const disabled = () => tree.root.findByProps({ accessibilityLabel: 'Sign in', accessibilityRole: 'button' })
      .props.accessibilityState.disabled;

    expect(disabled()).toBe(true);
    type(tree, 'Email', 'creator@example.com');
    type(tree, 'Password', 'abc');
    expect(disabled()).toBe(false);
  });

  it('agrees with the copy layer about what is valid', () => {
    expect(validateCredentials('creator@example.com', 'correcthorse')).toBeNull();
    expect(validateCredentials('nobody2example', 'correcthorse')?.title).toBe('Check the email address');
    expect(validateCredentials('creator@example.com', 'short')?.title).toBe('Password is too short');
  });
});

describe('S2 — the front door uses the app\'s own controls', () => {
  it('draws the segmented control the way the rest of the app draws it', () => {
    const tree = render();
    const selected = { accessibilityLabel: 'Switch to sign in' };
    const unselected = { accessibilityLabel: 'Switch to sign up' };

    for (const tab of [selected, unselected]) {
      expect(hosts(tree, tab)[0].props.accessibilityRole).toBe('tab');
      expect(styleOf(tree, tab).minHeight).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    }
    expect(styleOf(tree, selected).backgroundColor).toBe(appTheme.colors.primary);
    expect(styleOf(tree, unselected).backgroundColor).toBe('transparent');
  });

  it('keeps the Google button\'s spoken name equal to the name drawn on it', () => {
    platformState.os = 'android';
    const tree = render();
    // Google ships one asset, reading "Sign in with Google" in both modes, so
    // the accessible name must say that in both modes too — Voice Control can
    // only be asked for a control by the words on it.
    expect(hosts(tree, { accessibilityLabel: 'Sign in with Google' })).toHaveLength(1);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    expect(hosts(tree, { accessibilityLabel: 'Sign in with Google' })).toHaveLength(1);
    expect(hosts(tree, { accessibilityLabel: 'Sign up with Google' })).toHaveLength(0);
    // The mode it is in still reaches a screen reader, through the hint.
    expect(hosts(tree, { accessibilityLabel: 'Sign in with Google' })[0].props.accessibilityHint)
      .toContain('Creates your account');
  });

  it('says what it is doing while it waits, instead of going blank', () => {
    expect(authSource).toContain('loadingLabel="Signing in…"');
  });
});

describe('S2 — the fields say what they are', () => {
  it('labels both fields above the box, not only inside it', () => {
    const copy = JSON.stringify(render().toJSON());
    // Text fields: placeholder text disappears on the first keystroke.
    expect(copy).toContain('textTransform');
    for (const label of ['Email', 'Password']) {
      expect(copy).toContain(`"children":["${label}"]`);
    }
  });

  it('stops advertising a sign-up rule on a sign-in field', () => {
    expect(authSource).not.toContain('Minimum 6 characters');
  });

  it('offers a clear control once the email has something to clear', () => {
    const tree = render();
    expect(hosts(tree, { accessibilityLabel: 'Clear email' })).toHaveLength(0);

    type(tree, 'Email', 'creator@example.com');
    const [clear] = hosts(tree, { accessibilityLabel: 'Clear email' });
    expect(clear).toBeTruthy();

    renderer.act(() => clear.props.onPress());
    expect(tree.root.findByProps({ accessibilityLabel: 'Email' }).props.value).toBe('');
  });

  it('changes the glyph when the password is revealed, not just its colour', () => {
    const tree = render();
    expect(tree.root.findAllByType('eye-icon' as never)).toHaveLength(1);
    expect(tree.root.findAllByType('eye-off-icon' as never)).toHaveLength(0);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Show password' }).props.onPress();
    });

    expect(tree.root.findAllByType('eye-icon' as never)).toHaveLength(0);
    expect(tree.root.findAllByType('eye-off-icon' as never)).toHaveLength(1);
  });

  it('gives every control inside a field the 44pt floor', () => {
    const tree = render();
    type(tree, 'Email', 'creator@example.com');

    for (const label of ['Clear email', 'Show password']) {
      const style = styleOf(tree, { accessibilityLabel: label });
      expect(style.width).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
      expect(style.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    }
  });
});
