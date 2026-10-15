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

const linking = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => undefined),
}));

/** The screen's exits (Close, a swipe down, Android's back) arrive as beforeRemove. */
const navigationState = vi.hoisted(() => {
  const state = {
    listeners: [] as Array<() => void>,
    addListener: (_event: string, listener: () => void) => {
      state.listeners.push(listener);
      return () => {
        state.listeners = state.listeners.filter((entry) => entry !== listener);
      };
    },
  };
  return state;
});

const paramsState = vi.hoisted(() => ({ params: {} as Record<string, string> }));

const analytics = vi.hoisted(() => ({
  trackOnboardingEvent: vi.fn(async (_api: unknown, _eventName: string, _options?: { step?: string | null }) => undefined),
}));

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  api: {},
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
  useLocalSearchParams: () => paramsState.params,
  useNavigation: () => ({ addListener: navigationState.addListener }),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: ({ ...props }: MockProps) => React.createElement('apple-authentication-button', props),
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE', BLACK: 'BLACK' },
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', SIGN_UP: 'SIGN_UP' },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Image: (props: MockProps) => React.createElement('image', props),
  Linking: linking,
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
  ChevronLeft: (props: MockProps) => React.createElement('chevron-left-icon', props),
  Share: (props: MockProps) => React.createElement('share-icon', props),
  Share2: (props: MockProps) => React.createElement('share2-icon', props),
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

vi.mock('@/lib/onboarding', () => analytics);

import AuthScreen from '../app/auth';
import { ThemeScope } from '../lib/theme-context';

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

  it('draws the white Apple button on the dark scheme and the black one on the light', () => {
    let dark!: renderer.ReactTestRenderer;
    let light!: renderer.ReactTestRenderer;
    renderer.act(() => {
      dark = renderer.create(<AuthScreen />);
      light = renderer.create(<ThemeScope scheme="light"><AuthScreen /></ThemeScope>);
    });
    const styleOf = (tree: renderer.ReactTestRenderer) =>
      tree.root.find((node) => String(node.type) === 'apple-authentication-button').props.buttonStyle;
    expect(styleOf(dark)).toBe('WHITE');
    expect(styleOf(light)).toBe('BLACK');
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

    // One Google asset, one name: the artwork reads "Sign in with Google" in
    // both modes, so the accessible name matches it and the hint carries the
    // mode (see the comment on the control in app/auth.tsx).
    await renderer.act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: 'Sign in with Google',
        accessibilityHint: 'Creates your account with Google and returns to Magicbooklet',
      }).props.onPress();
    });

    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(authState.signUpWithPassword).not.toHaveBeenCalled();
  });

  it('draws Google alone on Android, without Apple', () => {
    platformState.os = 'android';
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });

    expect(providerButtonsInOrder(tree!)).toEqual(['Sign in with Google']);
  });
});

/**
 * The provider buttons as drawn, top to bottom: host elements only, in the
 * tree's own order.
 */
function providerButtonsInOrder(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => typeof node.type === 'string'
      && typeof node.props.accessibilityLabel === 'string'
      && /^Sign (in|up) with (Apple|Google)$/.test(node.props.accessibilityLabel))
    .map((node) => node.props.accessibilityLabel as string);
}

// Decision D1: Google on the iPhone too, so an account made with Google on
// Android or the web can be reached there (audit 01-1). Apple stays first.
describe('AuthScreen Google sign-in on iOS', () => {
  beforeEach(() => {
    platformState.os = 'ios';
    authState.user = null;
    paramsState.params = {};
    navigationState.listeners = [];
    authState.signInWithApple.mockReset();
    authState.signInWithApple.mockResolvedValue(undefined);
    authState.signInWithGoogle.mockReset();
    authState.signInWithGoogle.mockResolvedValue(undefined);
    authState.signInWithPassword.mockReset();
    authState.signInWithPassword.mockResolvedValue(undefined);
  });

  function mount() {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });
    return tree!;
  }

  it('draws Google under Apple, in both modes', () => {
    const tree = mount();
    expect(providerButtonsInOrder(tree)).toEqual(['Sign in with Apple', 'Sign in with Google']);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });
    expect(providerButtonsInOrder(tree)).toEqual(['Sign up with Apple', 'Sign in with Google']);
  });

  it('starts Google sign-in and leaves the screen once it succeeds', async () => {
    const { router } = await import('expo-router');
    const dismissTo = vi.mocked(router.dismissTo);
    dismissTo.mockClear();
    const tree = mount();

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Google', accessibilityRole: 'button' }).props.onPress();
    });

    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(authState.signInWithApple).not.toHaveBeenCalled();
    expect(dismissTo).toHaveBeenCalledWith('/(tabs)');
  });

  it('creates a new account with Google from the sign-up tab, never with a password', async () => {
    const tree = mount();
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });

    await renderer.act(async () => {
      tree.root.findByProps({
        accessibilityLabel: 'Sign in with Google',
        accessibilityHint: 'Creates your account with Google and returns to Magicbooklet',
      }).props.onPress();
    });

    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(authState.signUpWithPassword).not.toHaveBeenCalled();
  });

  it('says a failed Google sign-in in the app\'s words', async () => {
    authState.signInWithGoogle.mockRejectedValue(new Error('access_denied'));
    const tree = mount();

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Google', accessibilityRole: 'button' }).props.onPress();
    });

    const copy = JSON.stringify(tree.toJSON());
    expect(copy).toContain('Could not finish with Google');
    expect(copy).not.toContain('access_denied');
  });

  it('holds the other ways in while one sign-in is under way', async () => {
    let finishGoogle!: () => void;
    authState.signInWithGoogle.mockReturnValue(new Promise<void>((resolve) => {
      finishGoogle = resolve;
    }));
    const tree = mount();
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Email' }).props.onChangeText('creator@example.com');
      tree.root.findByProps({ accessibilityLabel: 'Password' }).props.onChangeText('correct-Horse-1');
    });

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Google', accessibilityRole: 'button' }).props.onPress();
    });

    // The innermost view that holds the system button decides whether it takes touches.
    const appleWrapper = () => tree.root
      .findAll((node) => String(node.type) === 'view'
        && 'pointerEvents' in node.props
        && node.findAll((child) => String(child.type) === 'apple-authentication-button').length === 1)
      .at(-1)!;
    const signInButton = () => tree.root.findByProps({ accessibilityLabel: 'Sign in', accessibilityRole: 'button' });
    expect(appleWrapper().props.pointerEvents).toBe('none');
    expect(signInButton().props.accessibilityState.disabled).toBe(true);

    // A press that lands anyway starts nothing.
    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
      signInButton().props.onPress();
    });
    expect(authState.signInWithApple).not.toHaveBeenCalled();
    expect(authState.signInWithPassword).not.toHaveBeenCalled();

    await renderer.act(async () => {
      finishGoogle();
    });
    expect(authState.signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('frees the other ways in again after a sign-in that failed', async () => {
    authState.signInWithGoogle.mockRejectedValue(new Error('access_denied'));
    const tree = mount();

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Google', accessibilityRole: 'button' }).props.onPress();
    });
    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });

    expect(authState.signInWithApple).toHaveBeenCalledWith('login');
  });
});

// Decision D2: no mail sender, so no password reset. "Forgot password?" led to
// a form whose mail never came (audit 01-2); support stands in its place.
describe('AuthScreen help for someone who cannot sign in', () => {
  const supportLabel = 'Trouble signing in? Email info@magicbooklet.com';

  beforeEach(() => {
    authState.user = null;
    paramsState.params = {};
    linking.openURL.mockClear();
  });

  function mount(os: string) {
    platformState.os = os;
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });
    return tree!;
  }

  it.each(['ios', 'android'])('offers no password reset on %s', (os) => {
    const tree = mount(os);
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/forgot/i);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Forgot password?' })).toHaveLength(0);
    expect(readFileSync('app/auth.tsx', 'utf8')).not.toContain('recovery=1');
  });

  it.each(['ios', 'android'])('puts the support line under the password on %s, and mails support from it', (os) => {
    const tree = mount(os);
    const [link] = tree.root.findAllByProps({ accessibilityLabel: supportLabel })
      .filter((node) => typeof node.type === 'string');
    expect(link.props).toMatchObject({ accessibilityRole: 'link', accessibilityHint: 'Opens your email app' });
    expect(link.findAll((node) => String(node.type) === 'text').map((node) => node.props.children))
      .toEqual(['Trouble signing in?', 'Email info@magicbooklet.com']);

    // Where "Forgot password?" stood: after the password field, before Sign in.
    const order = tree.root
      .findAll((node) => typeof node.type === 'string'
        && [supportLabel, 'Password', 'Sign in'].includes(node.props.accessibilityLabel))
      .map((node) => node.props.accessibilityLabel);
    expect(order).toEqual(['Password', supportLabel, 'Sign in']);

    renderer.act(() => {
      link.props.onPress();
    });
    expect(linking.openURL).toHaveBeenCalledWith('mailto:info@magicbooklet.com?subject=Trouble%20signing%20in');
  });

  it('keeps the address on screen when no mail app can open it', async () => {
    linking.openURL.mockRejectedValueOnce(new Error('Unable to open URL: mailto:info@magicbooklet.com'));
    const tree = mount('ios');

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: supportLabel, accessibilityRole: 'link' }).props.onPress();
    });

    expect(JSON.stringify(tree.toJSON())).toContain('Email info@magicbooklet.com');
  });

  it('shows the line beside the password form only, not on the sign-up tab', () => {
    const tree = mount('ios');
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.onPress();
    });
    expect(tree.root.findAllByProps({ accessibilityLabel: supportLabel })).toHaveLength(0);
  });
});

describe('AuthScreen sign-in analytics (audit 01-11)', () => {
  beforeEach(() => {
    platformState.os = 'ios';
    authState.user = null;
    paramsState.params = {};
    navigationState.listeners = [];
    analytics.trackOnboardingEvent.mockClear();
    authState.signInWithApple.mockReset();
    authState.signInWithApple.mockResolvedValue(undefined);
  });

  function mount() {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });
    return tree!;
  }

  const recorded = () => analytics.trackOnboardingEvent.mock.calls.map(([, eventName, options]) => [eventName, options?.step]);

  /** The person leaves the screen: Close, a swipe down, Android's back. */
  const leave = () => {
    renderer.act(() => {
      navigationState.listeners.forEach((listener) => listener());
    });
  };

  it('records a sign-in from its first attempt to its success, with the route it was headed for', async () => {
    paramsState.params = { returnTo: '/creator/sam?tab=posts' };
    const tree = mount();
    expect(recorded()).toEqual([]);

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });

    expect(recorded()).toEqual([['auth_started', '/creator/sam'], ['auth_succeeded', '/creator/sam']]);
    expect(analytics.trackOnboardingEvent).toHaveBeenCalledWith(authState.api, 'auth_started', { step: '/creator/sam' });

    // The screen's own exit after a success is not a cancel.
    leave();
    expect(recorded()).toHaveLength(2);
  });

  it('counts one start per visit, however many attempts it takes', async () => {
    authState.signInWithApple.mockRejectedValueOnce(new Error('nonce mismatch'));
    const tree = mount();

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });
    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });

    expect(recorded()).toEqual([['auth_started', '/(tabs)'], ['auth_succeeded', '/(tabs)']]);
  });

  it('records a visit left without signing in as canceled, once', async () => {
    authState.signInWithApple.mockRejectedValue(new Error('nonce mismatch'));
    const tree = mount();

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Sign in with Apple' }).props.onPress();
    });
    leave();
    leave();

    expect(recorded()).toEqual([['auth_started', '/(tabs)'], ['auth_canceled', '/(tabs)']]);
  });

  it('records nothing for a screen opened by someone signed in already', () => {
    authState.user = { id: 'user-1' };
    mount();
    leave();

    expect(recorded()).toEqual([]);
  });
});

describe('AuthScreen copy names only the buttons it draws (audit 01-8)', () => {
  beforeEach(() => {
    authState.user = null;
    paramsState.params = {};
    navigationState.listeners = [];
    authState.signInWithPassword.mockReset();
    authState.signInWithPassword.mockRejectedValue(new Error('Invalid login credentials'));
  });

  async function wrongPasswordNotice(os: string) {
    platformState.os = os;
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthScreen />);
    });
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Email' }).props.onChangeText('creator@example.com');
      tree!.root.findByProps({ accessibilityLabel: 'Password' }).props.onChangeText('wrong-password');
    });
    await renderer.act(async () => {
      tree!.root.findByProps({ label: 'Sign in' }).props.onPress();
    });
    return tree!.root.findAll((node) => typeof node.props.body === 'string')[0]?.props.body as string;
  }

  it('points a wrong password at Google on Android, and never at Apple', async () => {
    const body = await wrongPasswordNotice('android');
    expect(body).toContain('created the account with Google');
    expect(body).not.toContain('Apple');
  });

  it('points a wrong password at both buttons on iOS, Apple first', async () => {
    const body = await wrongPasswordNotice('ios');
    expect(body).toContain('created the account with Apple or Google, use that button instead');
  });
});
