import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appTheme, themes } from '../lib/theme';
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

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@/components/media-wall', () => ({ MediaWall: () => null }));
vi.mock('expo-router', () => ({
  router: { canGoBack: vi.fn(() => false), back: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() },
  useNavigation: () => ({ addListener: () => () => undefined }),
  Link: (props: MockProps) => React.createElement('link', props),
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  // The email form, behind the sign-in page's "Sign in with email".
  useRoute: () => ({ key: 'auth-1', name: 'auth', params: { email: '1' } }),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: (props: MockProps) => React.createElement('apple-authentication-button', props),
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE' },
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', SIGN_UP: 'SIGN_UP' },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Image: (props: MockProps) => React.createElement('image', props),
  Linking: { openURL: vi.fn(async () => undefined) },
  Platform: {
    get OS() {
      return platformState.os;
    },
    select: (obj: Record<string, unknown>) => obj[platformState.os] || obj.default,
  },
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', { ...props, style: resolvePressableStyle(style) }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  StyleSheet: { absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
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
vi.mock('@/lib/onboarding', () => ({ trackOnboardingEvent: vi.fn(async () => undefined) }));

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
  // Sign in with Apple: "Make a Sign in with Apple button no smaller than other sign-in
  // buttons". They live on the sign-in page now (components/sign-in-wall.tsx), one height and
  // one width each.
  const wallSource = readFileSync('components/sign-in-wall.tsx', 'utf8');

  it('draws Apple and Google at one height and the full width', () => {
    expect(wallSource).toContain("style={{ width: '100%', height: BUTTON_HEIGHT }}");
    expect(wallSource).toMatch(/accessibilityLabel="Continue with Google"[\s\S]*?height: BUTTON_HEIGHT,/);
    expect(wallSource).not.toContain('GOOGLE_BUTTON_ASPECT');
  });

  it('keeps Apple first where both are drawn (iOS, App Review 4.8)', () => {
    expect(wallSource.indexOf("providers.includes('Apple')")).toBeLessThan(wallSource.indexOf("providers.includes('Google')"));
  });
});

describe('S2 — the alert is kept for real failures', () => {
  it('keeps the alert for a genuine misconfiguration', () => {
    authState.isAuthConfigured = false;
    authState.missingEnvKeys = ['EXPO_PUBLIC_SUPABASE_URL'];

    expect(alerts(render())).toHaveLength(1);
  });

});

describe('S2 — a failure is told in the app\'s words, where it can be seen', () => {
  it('never repeats the provider message', () => {
    expect(describePasswordSignInError(new Error('Invalid login credentials')).title)
      .toBe('That email and password do not match');
    expect(describePasswordSignInError(new Error('Email not confirmed')).title)
      .toBe('This email address is not confirmed');
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
  it('says what it is doing while it waits, instead of going blank', () => {
    expect(authSource).toContain("isSubmitting ? 'Signing in…' : 'Sign in'");
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

  it('gives the support line under the password the 44pt floor, and lets its halves wrap as a pair', () => {
    const style = styleOf(render(), { accessibilityLabel: 'Trouble signing in? Email info@magicbooklet.com' });
    expect(style.minHeight).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    // Two runs that wrap whole, so the address is never broken across lines.
    expect(style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
  });
});
