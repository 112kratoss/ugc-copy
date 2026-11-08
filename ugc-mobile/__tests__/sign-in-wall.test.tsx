import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Effects and state updates flush inside act(), as React expects of a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    push: vi.fn(),
    replace: vi.fn(),
  },
  useNavigation: () => ({ addListener: navigationState.addListener }),
}));

// The screen reads its params from the route itself (auth-screen-return-to.test.tsx says why).
vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useRoute: () => ({ key: 'auth-1', name: 'auth', params: paramsState.params }),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: ({ ...props }: MockProps) => React.createElement('apple-authentication-button', props),
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE', BLACK: 'BLACK' },
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', SIGN_UP: 'SIGN_UP', CONTINUE: 'CONTINUE' },
}));

vi.mock('react-native', () => ({
  Animated: (() => {
    class Value {
      value: number;
      constructor(value: number) { this.value = value; }
      setValue(value: number) { this.value = value; }
      interpolate() { return this; }
    }
    const animation = (value: Value, config: { toValue: number }) => ({
      start: (done?: () => void) => { value.value = config.toValue; done?.(); },
      stop: () => undefined,
    });
    return {
      Value,
      View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
      timing: animation,
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      add: (a: Value) => a,
      modulo: (a: Value) => a,
    };
  })(),
  Easing: { out: (fn: unknown) => fn, cubic: (t: number) => t, linear: (t: number) => t },
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
  StyleSheet: { absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
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

vi.mock('expo-status-bar', () => ({
  StatusBar: (props: MockProps) => React.createElement('status-bar', props),
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
  // A fresh object each render, as the provider's context value is once the user changes.
  useAuth: () => ({ ...authState }),
}));

vi.mock('@/lib/apple-auth', () => ({
  isAppleAuthCanceled: () => false,
}));

vi.mock('@/lib/google-auth', () => ({
  isGoogleAuthCanceled: () => false,
}));

vi.mock('@/lib/onboarding', () => analytics);

vi.mock('@/components/media-wall', async () => {
  const actual = await vi.importActual<typeof import('../components/media-wall')>('../components/media-wall');
  return { ...actual, MediaWall: (props: MockProps) => React.createElement('media-wall', props) };
});

const hardwareBack = vi.hoisted(() => ({ handler: null as null | (() => void) }));
vi.mock('@/lib/use-hardware-back', () => ({
  useHardwareBack: (_enabled: boolean, handler: () => void) => {
    hardwareBack.handler = handler;
  },
}));

vi.mock('../assets/images/sign-in-wall/wall-01.jpg', () => ({ default: 1 }));

import AuthRoute from '../app/auth';
import JoinScreen from '../app/join';
import { EmailSignInForm } from '../components/email-sign-in-form';
import { MEDIA_WALL_TILES, mediaWallColumn, mediaWallGeometry } from '../components/media-wall';
import { signInOpensOnEmailForm } from '../lib/join-navigation';

async function routerMock() {
  const { router } = await import('expo-router');
  for (const fn of [router.replace, router.back, router.dismissTo, router.push]) vi.mocked(fn).mockClear();
  vi.mocked(router.canGoBack).mockReturnValue(true);
  return router;
}

function render(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree!;
}

describe('the sign-in wall of creations', () => {
  it('covers the screen at both ends of every column\'s slide, so the loop never shows a gap', () => {
    for (const [width, height] of [[320, 568], [390, 844], [430, 932], [1024, 1366]]) {
      const g = mediaWallGeometry(width, height);
      // A column spans [top + o, top + o + 2·cycle] for o in [-cycle, 0]; the tilt needs a margin.
      const margin = height * 0.12;
      expect(g.top).toBeLessThanOrEqual(-margin);
      expect(g.top - g.cycle + 2 * g.cycle).toBeGreaterThanOrEqual(height + margin);
      // Wide enough that the screen, turned by the tilt, stays inside the wall.
      const tilt = (10 * Math.PI) / 180;
      expect(g.wallWidth).toBeGreaterThanOrEqual(width * Math.cos(tilt) + height * Math.sin(tilt));
    }
  });

  it('ships twelve pictures, six to each of five columns, and never the same one in neighbouring columns', () => {
    expect(MEDIA_WALL_TILES).toHaveLength(12);
    for (let column = 0; column < 5; column += 1) {
      const own = mediaWallColumn(column);
      expect(new Set(own).size).toBe(6);
      if (column === 4) continue;
      const next = new Set(mediaWallColumn(column + 1));
      expect(own.some((tile) => next.has(tile))).toBe(false);
    }
  });
});

describe('which sign-in the route opens on (owner, 2026-11-08: one full-screen page)', () => {
  it('opens on the page, and on the email form only after "Sign in with email"', () => {
    expect(signInOpensOnEmailForm(undefined)).toBe(false);
    expect(signInOpensOnEmailForm('0')).toBe(false);
    expect(signInOpensOnEmailForm('1')).toBe(true);
    expect(signInOpensOnEmailForm(['1'])).toBe(true);
  });

  beforeEach(() => {
    platformState.os = 'ios';
    authState.user = null;
    paramsState.params = {};
    authState.signInWithApple.mockReset();
    authState.signInWithApple.mockResolvedValue(undefined);
    authState.signInWithGoogle.mockReset();
    authState.signInWithGoogle.mockResolvedValue(undefined);
    analytics.trackOnboardingEvent.mockClear();
  });

  it('draws the wall, the headline and the three ways in for a plain "Sign in"', () => {
    paramsState.params = { returnTo: '/profile' };
    const tree = render(<AuthRoute />);
    expect(tree.root.findAllByType('media-wall' as never)).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('Start\\nfilling your');
    expect(tree.root.findByProps({ accessibilityLabel: 'Continue with Apple' }).props.buttonStyle).toBe('WHITE');
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Continue with Google' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Email' })).toHaveLength(0);
  });

  it('turns the same page into the email form, over the same moving wall, and back again', async () => {
    const router = await routerMock();
    paramsState.params = { returnTo: '/profile' };
    const tree = render(<AuthRoute />);
    expect(tree.root.findAllByType(EmailSignInForm)).toHaveLength(0);
    renderer.act(() => {
      tree.root.findAllByProps({ accessibilityLabel: 'Sign in with email' })[0].props.onPress();
    });
    // No new screen: the form is the page's second half, in front now.
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    const form = tree.root.findByType(EmailSignInForm);
    expect(form.props.active).toBe(true);
    expect(form.props.returnTo).toBe('/profile');
    expect(tree.root.findAllByType('media-wall' as never)).toHaveLength(1);
    // Its X, and Android's back, turn the page back rather than leave it.
    renderer.act(() => {
      form.findByProps({ accessibilityLabel: 'Back to all sign-in options' }).props.onPress();
    });
    expect(tree.root.findByType(EmailSignInForm).props.active).toBe(false);
    expect(router.back).not.toHaveBeenCalled();
  });

  it('opens on the email half for email=1, with Apple and Google under the form', () => {
    paramsState.params = { email: '1' };
    const tree = render(<AuthRoute />);
    const form = tree.root.findByType(EmailSignInForm);
    expect(form.props.active).toBe(true);
    expect(form.findAllByProps({ accessibilityLabel: 'Email' }).length).toBeGreaterThan(0);
    expect(form.findAllByProps({ accessibilityLabel: 'Continue with Apple' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Switch to sign up' })).toHaveLength(0);
  });

  it('says why on the page when a redirect sent the person back (most return with Apple or Google)', () => {
    paramsState.params = { notice: 'signed-out', returnTo: '/profile' };
    const tree = render(<AuthRoute />);
    expect(tree.root.findAllByType('media-wall' as never)).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('signed out');
  });

  it('starts Apple as a sign-up, which makes an account or signs into one', async () => {
    const tree = render(<AuthRoute />);
    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Continue with Apple' }).props.onPress();
    });
    expect(authState.signInWithApple).toHaveBeenCalledWith('signup');
    expect(analytics.trackOnboardingEvent.mock.calls.map((call) => call[1])).toEqual(['screen_viewed', 'auth_started']);
  });

  it('goes on to the name and credits once signed in, and back to where the person was', async () => {
    const router = await routerMock();
    paramsState.params = { returnTo: '/post/post-1' };
    authState.user = { id: 'user-1' };
    render(<AuthRoute />);
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/onboarding', params: { returnTo: '/post/post-1' } });
  });

  it('closes back to the page beneath, but not while a sign-in is finishing', async () => {
    const router = await routerMock();
    let finish: () => void = () => {};
    authState.signInWithGoogle.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const tree = render(<AuthRoute />);
    renderer.act(() => {
      tree.root.findAllByProps({ accessibilityLabel: 'Continue with Google' })[0].props.onPress();
    });
    renderer.act(() => hardwareBack.handler?.());
    expect(router.back).not.toHaveBeenCalled();
    await renderer.act(async () => finish());
    renderer.act(() => hardwareBack.handler?.());
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(analytics.trackOnboardingEvent.mock.calls.map((call) => call[1])).toContain('auth_canceled');
  });

  it('sends a guest from the join route to the email form with the name and credits still ahead', async () => {
    const router = await routerMock();
    paramsState.params = { returnTo: '/create/image?remix=gen-1' };
    const tree = render(<JoinScreen />);
    renderer.act(() => {
      tree.root.findAllByProps({ accessibilityLabel: 'Sign in with email' })[0].props.onPress();
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(tree.root.findByType(EmailSignInForm).props.returnTo)
      .toBe(`/onboarding?returnTo=${encodeURIComponent('/create/image?remix=gen-1')}`);
  });
});
