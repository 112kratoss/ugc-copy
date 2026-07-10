import React from 'react';
import renderer from 'react-test-renderer';
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
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
  signInWithApple: vi.fn(),
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
    replace: vi.fn(),
  },
  useLocalSearchParams: () => ({}),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
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
  Apple: (props: MockProps) => React.createElement('apple-icon', props),
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

import AuthScreen from '../app/auth';

describe('AuthScreen Apple sign-in', () => {
  beforeEach(() => {
    platformState.os = 'ios';
    authState.signInWithApple.mockReset();
    authState.signInWithApple.mockResolvedValue(undefined);
  });

  it('starts Apple sign-in in login mode on iOS', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Apple' }).props.onPress();
    });

    expect(authState.signInWithApple).toHaveBeenCalledWith('login');
  });

  it('hides Apple sign-in outside iOS', () => {
    platformState.os = 'android';

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Apple' })).toHaveLength(0);
  });
});
