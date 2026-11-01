import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// expo-router's own code for both ends of a push: `resolveHref` writes the caller's
// `{ pathname, params }` as a path, and `parseQueryParams` is how `getStateFromPath`
// reads that path's query into the params React Navigation gives the route.
import { resolveHref } from 'expo-router/build/link/href';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const routeState = vi.hoisted(() => ({
  params: {} as Record<string, string | string[]>,
  /**
   * What expo-router 55's `useLocalSearchParams` (build/hooks.js) returns for these
   * params: each one through `decodeURIComponent` again, one it cannot decode as it is.
   * A screen that went back to reading its return through it fails here as on a phone.
   */
  localSearchParams(params: Record<string, string | string[]>) {
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(decode) : decode(value),
    ]));
  },
}));

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  api: {},
  signInWithPassword: vi.fn(),
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
  isAuthConfigured: true,
  missingEnvKeys: [] as string[],
}));

vi.mock('@react-navigation/native', () => ({
  useRoute: () => ({ key: 'auth-1', name: 'auth', params: routeState.params }),
}));

vi.mock('expo-router', () => ({
  router: { canGoBack: vi.fn(() => false), back: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => routeState.localSearchParams(routeState.params),
  useNavigation: () => ({ addListener: () => () => undefined }),
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: (props: MockProps) => React.createElement('apple-authentication-button', props),
  AppleAuthenticationButtonStyle: { WHITE: 'WHITE', BLACK: 'BLACK' },
  AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', SIGN_UP: 'SIGN_UP' },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Image: (props: MockProps) => React.createElement('image', props),
  Linking: { openURL: vi.fn(async () => undefined) },
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios || obj.default },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
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
vi.mock('@/lib/onboarding', () => ({ trackOnboardingEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth-navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-navigation')>();
  return { ...actual, completeAuthScreen: vi.fn(actual.completeAuthScreen) };
});

import { router } from 'expo-router';
import AuthScreen from '../app/auth';
import { completeAuthScreen } from '../lib/auth-navigation';

/** The auth route's params after a caller's `router.push({ pathname: '/auth', params })`. */
function authRoute(params: Record<string, string>) {
  return parseQueryParams(resolveHref({ pathname: '/auth', params }), { name: 'auth' }) ?? {};
}

function authRouteParams(returnTo: string) {
  return authRoute({ returnTo });
}

/** Everything a decode once too many loses: & and # cut it, + turns to a space, \ and a line break send it Home. */
const PROMPT = 'A dancer & a drum #2 + 100% real \\ one\nline two';

const RETURNS: Array<[string, string]> = [
  [
    'the creator with a prompt (&, #, +, %, a backslash, a line break)',
    `/create/video?remix=gen-9&remixPost=post-9&prompt=${encodeURIComponent(PROMPT)}&guided=1`,
  ],
  [
    'a link written as a form (a space as +), as remix links are',
    `/create/video?${new URLSearchParams({ remix: 'gen-9', sourceTitle: 'Rooftop sparring & co', sourceCreator: '@whiskers' })}`,
  ],
  [
    'an invite with the path it goes on to',
    `/r/AB12?next=${encodeURIComponent('/post/p-1?comments=p-1&replyTo=c-2')}`,
  ],
];

describe('the sign-in return', () => {
  beforeEach(() => {
    vi.mocked(completeAuthScreen).mockClear();
    vi.mocked(router.dismissTo).mockClear();
    authState.user = null;
  });

  it.each(RETURNS)('reaches the auth route exactly as built: %s', (_label, returnTo) => {
    expect(authRouteParams(returnTo).returnTo).toBe(returnTo);
  });

  it.each(RETURNS)('is handed on exactly as the caller built it: %s', async (_label, returnTo) => {
    routeState.params = authRouteParams(returnTo);
    authState.user = { id: 'user-1' };

    await renderer.act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(completeAuthScreen).toHaveBeenCalledTimes(1);
    expect(completeAuthScreen).toHaveBeenCalledWith(router, returnTo);
    expect(router.dismissTo).toHaveBeenCalledWith(returnTo);
  });

  // The screen reads its params from the route because of this second decode. Should a later
  // expo-router stop making it, `useLocalSearchParams` is safe for the return again.
  it('is read past the decode expo-router’s useLocalSearchParams still adds', () => {
    const hooks = readFileSync('node_modules/expo-router/build/hooks.js', 'utf8');
    const start = hooks.indexOf('function useLocalSearchParams(');
    const body = hooks.slice(start, hooks.indexOf('\nfunction ', start + 1));
    expect(body).toContain('LocalRouteParamsContext');
    expect(body).toContain('decodeURIComponent(value)');
  });
});

describe("the sign-in screen's other params", () => {
  beforeEach(() => {
    vi.mocked(router.dismissTo).mockClear();
    authState.user = null;
  });

  const render = () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<AuthScreen />); });
    return tree;
  };
  const texts = (tree: renderer.ReactTestRenderer) => tree.root
    .findAll((node) => node.type === 'text')
    .flatMap((node) => React.Children.toArray(node.props.children))
    .filter((child): child is string => typeof child === 'string');

  // The sign-up pushes: the invite, the profile, onboarding and Pricing.
  it('opens on Sign up when the push asks for it', () => {
    routeState.params = authRoute({ mode: 'signup', returnTo: '/onboarding' });

    const tree = render();

    expect(tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.accessibilityState).toEqual({ selected: true });
  });

  // `signInNoticeRoute`, after this device's session ended elsewhere.
  it('says why a redirect sent the person here', () => {
    routeState.params = authRoute({ notice: 'signed-out', returnTo: '/create/video' });

    expect(texts(render())).toContain('You were signed out');
  });

  // A route with an empty query has no params object at all.
  it('opens on Sign in with no params, and steps aside for someone signed in', async () => {
    routeState.params = undefined as unknown as Record<string, string>;
    expect(render().root.findByProps({ accessibilityLabel: 'Switch to sign in' }).props.accessibilityState).toEqual({ selected: true });

    authState.user = { id: 'user-1' };
    await renderer.act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)');
  });
});
