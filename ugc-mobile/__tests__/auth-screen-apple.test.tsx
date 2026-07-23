import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const platformState = vi.hoisted(() => ({
  os: 'ios',
}));

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
  isAuthConfigured: true,
  missingEnvKeys: [] as string[],
}));

vi.mock('expo-router', () => ({
  Stack: {
    Screen: (props: MockProps) => React.createElement('stack-screen', props),
  },
  router: {
    canGoBack: vi.fn(() => false),
    back: vi.fn(),
    dismissTo: vi.fn(),
    replace: vi.fn(),
  },
  useLocalSearchParams: () => ({}),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: ({ ...props }: MockProps) => React.createElement('apple-authentication-button', props),
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
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-svg', () => ({
  default: ({ children, ...props }: MockProps) => React.createElement('svg', props, children),
  Path: (props: MockProps) => React.createElement('path', props),
}));

vi.mock('lucide-react-native', () => ({
  AlertCircle: (props: MockProps) => React.createElement('alert-circle-icon', props),
  ArrowLeft: (props: MockProps) => React.createElement('arrow-left-icon', props),
  Eye: (props: MockProps) => React.createElement('eye-icon', props),
  LockKeyhole: (props: MockProps) => React.createElement('lock-icon', props),
  Mail: (props: MockProps) => React.createElement('mail-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  WandSparkles: (props: MockProps) => React.createElement('wand-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/apple-auth', () => ({
  isAppleAuthCanceled: () => false,
}));

vi.mock('@/lib/google-auth', () => ({
  isGoogleAuthCanceled: () => false,
}));

import AuthScreen from '../app/auth';

describe('AuthScreen Apple sign-in', () => {
  beforeEach(() => {
    platformState.os = 'ios';
    authState.user = null;
    authState.signInWithApple.mockReset();
    authState.signInWithApple.mockResolvedValue(undefined);
    authState.signUpWithPassword.mockReset();
    authState.signInWithGoogle.mockReset();
    authState.signInWithGoogle.mockResolvedValue(undefined);
  });

  it('keeps auth modal options in the root navigator so typing does not remount the form', () => {
    const authSource = readFileSync('app/auth.tsx', 'utf8');
    const layoutSource = readFileSync('app/_layout.tsx', 'utf8');

    expect(authSource).not.toContain('<Stack.Screen');
    expect(layoutSource).toMatch(/name="auth"[\s\S]*?headerShown: false/);
  });

  it('retains the controlled email value while typing', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Email' }).props.onChangeText('creator@example.com');
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Email' }).props.value).toBe('creator@example.com');
  });

  it('starts Apple sign-in in login mode on iOS', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });

    expect(authState.signInWithApple).toHaveBeenCalledWith('login');
  });

  it('uses Apple for new iOS accounts and keeps email/password sign-up unavailable', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Email' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Password' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Create account' })).toHaveLength(0);

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Sign up with Apple' }).props.onPress();
    });

    expect(authState.signInWithApple).toHaveBeenCalledWith('signup');
    expect(authState.signUpWithPassword).not.toHaveBeenCalled();
  });

  it('dismisses the auth flow after Apple sign-in succeeds', async () => {
    const { router } = await import('expo-router');
    const dismissTo = vi.mocked(router.dismissTo);
    dismissTo.mockClear();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });

    expect(dismissTo).toHaveBeenCalledTimes(1);
    expect(dismissTo).toHaveBeenCalledWith('/(tabs)');
  });

  it('automatically dismisses auth when a session already exists', async () => {
    const { router } = await import('expo-router');
    const dismissTo = vi.mocked(router.dismissTo);
    dismissTo.mockClear();
    authState.user = { id: 'user-1' };

    await renderer.act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(dismissTo).toHaveBeenCalledTimes(1);
    expect(dismissTo).toHaveBeenCalledWith('/(tabs)');
  });

  it('hides Apple sign-in outside iOS', () => {
    platformState.os = 'android';

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Sign in with Apple' })).toHaveLength(0);
  });

  it('starts Google sign-in on Android', async () => {
    platformState.os = 'android';

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Sign in with Google' }).props.onPress();
    });

    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('uses Google for new Android accounts and keeps email/password sign-up unavailable', async () => {
    platformState.os = 'android';
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Email' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Password' })).toHaveLength(0);

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Sign up with Google' }).props.onPress();
    });

    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(authState.signUpWithPassword).not.toHaveBeenCalled();
  });

  it('does not show Google sign-in on iOS', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Sign in with Google' })).toHaveLength(0);
  });
});
