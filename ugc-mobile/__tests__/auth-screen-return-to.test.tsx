import React from 'react';
import renderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StackRouter, type ParamListBase, type StackNavigationState } from '@react-navigation/routers';
// expo-router's own code for both ends of a push: `resolveHref` writes the caller's
// `{ pathname, params }` as a path, and `parseQueryParams` is how `getStateFromPath`
// reads that path's query into the params React Navigation gives the route.
import { resolveHref } from 'expo-router/build/link/href';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';

import { pushedRoute } from './fixtures/navigation-state';

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
import { completeAuthScreen, focusedRouteReturnPath, signInNoticeRoute } from '../lib/auth-navigation';

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
    expect(completeAuthScreen).toHaveBeenCalledWith(router, returnTo, { inPlace: false });
    expect(router.dismissTo).toHaveBeenCalledWith(returnTo);
  });

  // This screen and the creator route (`app/create/[tool].tsx`) read their params from the route
  // because of this second decode, and both tests stand in for the hook with it
  // (`create-tool-screen.test.tsx` too). Should a later expo-router stop making it, update both
  // stand-ins; `useLocalSearchParams` is then safe for either screen's text again.
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

    expect(tree.root.findByProps({ accessibilityLabel: 'Switch to sign up' }).props.accessibilityState).toMatchObject({ selected: true });
  });

  // `signInNoticeRoute`, after this device's session ended elsewhere.
  it('says why a redirect sent the person here', () => {
    routeState.params = authRoute({ notice: 'signed-out', returnTo: '/create/video' });

    expect(texts(render())).toContain('You were signed out');
  });

  // A route with an empty query has no params object at all.
  it('opens on Sign in with no params, and steps aside for someone signed in', async () => {
    routeState.params = undefined as unknown as Record<string, string>;
    expect(render().root.findByProps({ accessibilityLabel: 'Switch to sign in' }).props.accessibilityState).toMatchObject({ selected: true });

    authState.user = { id: 'user-1' };
    await renderer.act(async () => {
      renderer.create(<AuthScreen />);
    });

    expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)');
  });
});

type RootStack = StackNavigationState<ParamListBase>;
type StackRoute = RootStack['routes'][number];

const ROOT_ROUTER_OPTIONS = {
  routeNames: ['(tabs)', 'viewer', 'creators/[username]', 'auth', '+not-found'],
  routeParamList: {},
  routeGetIdList: {},
};
const stackRouter = StackRouter({});
let rootStack: RootStack;

function rootStackOf(...routes: StackRoute[]): RootStack {
  return {
    stale: false,
    type: 'stack',
    key: 'root-stack',
    index: routes.length - 1,
    routeNames: ROOT_ROUTER_OPTIONS.routeNames,
    routes,
    preloadedRoutes: [],
  };
}

/** The app's navigation state with this root stack, under expo-router's `__root` slot. */
const rootStateOf = (stack: RootStack) => ({ routes: [{ name: '__root', state: stack }] });

/**
 * The root stack as React Navigation runs it for expo-router's `router`: `dismissTo` sends it a
 * POP_TO and `replace` a REPLACE, naming the route a path names (one static segment here) with the
 * params a push of the path gives it. An action the stack refuses fails the test.
 */
function dispatchToRootStack(type: 'POP_TO' | 'REPLACE') {
  return (href: unknown) => {
    const path = typeof href === 'string' ? href : resolveHref(href as never);
    const name = new URL(path, 'file:').pathname.slice(1);
    const next = stackRouter.getStateForAction(
      rootStack,
      { type, payload: { name, params: parseQueryParams(path, { name }) } },
      ROOT_ROUTER_OPTIONS,
    );
    if (!next) throw new Error(`The root stack refused ${type} ${path}`);
    rootStack = next as RootStack;
  };
}

/** A reel as a push of it leaves it on the stack. */
function reelRoute(key: string, params: Record<string, string>): StackRoute {
  const { name, params: routeParams } = pushedRoute('/viewer', params);
  return { key, name, params: routeParams };
}

describe('the sign-in screen, signed in, on the root stack', () => {
  const TABS: StackRoute = { key: 'tabs', name: '(tabs)' };
  const REEL_A = reelRoute('reel-a', { source: 'home', initialId: 'post-a' });
  const REEL_B = reelRoute('reel-b', { source: 'profile-creations', initialId: 'post-b' });
  const REEL_B_RETURN = '/viewer?source=profile-creations&initialId=post-b';

  beforeEach(() => {
    vi.mocked(router.dismissTo).mockImplementation(dispatchToRootStack('POP_TO'));
    vi.mocked(router.replace).mockImplementation(dispatchToRootStack('REPLACE'));
    authState.user = { id: 'user-1' };
  });

  afterEach(() => {
    vi.mocked(router.dismissTo).mockReset();
    vi.mocked(router.replace).mockReset();
    authState.user = null;
  });

  /** The sign-in screen in front of the stack, signed in: it completes, and is gone. */
  const completeOnTop = async () => {
    routeState.params = rootStack.routes[rootStack.index].params as Record<string, string>;
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<AuthScreen />);
    });
    renderer.act(() => tree.unmount());
  };

  /** What `AuthProvider` does at a forced sign-out: sign-in in place of the route in front. */
  const forceSignIn = (returnTo: string | null, { inPlace }: { inPlace: boolean }) => {
    router.replace(signInNoticeRoute('signed-out', returnTo, { inPlace }) as never);
  };

  // Reel A, then reel B over it, and B's session ended elsewhere.
  it('puts the screen a forced sign-in took the place of back there, not on an earlier one of its name', async () => {
    rootStack = rootStackOf(TABS, REEL_A, REEL_B);
    forceSignIn(focusedRouteReturnPath(rootStateOf(rootStack)), { inPlace: true });

    await completeOnTop();

    // A pop to reel A gave it B's params, and A's own saved post won over them.
    expect(rootStack.routes).toMatchObject([TABS, REEL_A, { name: 'viewer', params: REEL_B.params }]);
  });

  // Reel B's session ended while the person opened a creator page from it: sign-in took the
  // page's place, and B, its return, is still below.
  it('takes a forced sign-in back to its return when another screen took sign-in to its place', async () => {
    rootStack = rootStackOf(TABS, REEL_A, REEL_B);
    const returnTo = focusedRouteReturnPath(rootStateOf(rootStack));
    rootStack = rootStackOf(TABS, REEL_A, REEL_B, { key: 'creator', name: 'creators/[username]', params: { username: 'luna' } });
    forceSignIn(returnTo, { inPlace: false });

    await completeOnTop();

    expect(rootStack.routes.map((route) => route.key)).toEqual(['tabs', 'reel-a', 'reel-b']);
  });

  // The reel's own prompt is pushed over it, and the reel waits below to be gone back to.
  it('takes an in-app prompt back to the screen that asked, still on the stack', async () => {
    rootStack = rootStackOf(TABS, REEL_A, REEL_B, { key: 'sign-in', name: 'auth', params: authRoute({ returnTo: REEL_B_RETURN }) });

    await completeOnTop();

    expect(rootStack.routes.map((route) => route.key)).toEqual(['tabs', 'reel-a', 'reel-b']);
  });

  // A page the app does not have was in front: no return (`signInNoticeRoute`).
  it('takes a forced sign-in with no return down to Home\'s tabs below it, not a second Home over them', async () => {
    rootStack = rootStackOf(TABS, { key: 'page', name: '+not-found' });
    forceSignIn(focusedRouteReturnPath(rootStateOf(rootStack)), { inPlace: true });

    await completeOnTop();

    expect(rootStack.routes.map((route) => route.key)).toEqual(['tabs']);
  });

  // The stand-in above, against the expo-router it stands in for.
  it('dispatches as expo-router does', () => {
    const routing = readFileSync('node_modules/expo-router/build/global-state/routing.js', 'utf8');
    const body = (name: string) => {
      const start = routing.indexOf(`function ${name}(`);
      return routing.slice(start, routing.indexOf('\nfunction ', start + 1));
    };
    expect(body('dismissTo')).toContain("event: 'POP_TO'");
    expect(body('replace')).toContain("event: 'REPLACE'");
    // The default, then the three changes: a push into another navigator, anything sent to tabs,
    // a replace in a drawer. To a stack, POP_TO and REPLACE go as they are.
    expect(body('getNavigateAction').match(/\btype = '[A-Z_]+'/g))
      .toEqual(["type = 'NAVIGATE'", "type = 'NAVIGATE'", "type = 'JUMP_TO'", "type = 'JUMP_TO'"]);
    // Its stack takes over PUSH, NAVIGATE and PRELOAD and hands the rest to React Navigation's.
    const stack = readFileSync('node_modules/expo-router/build/layouts/StackClient.js', 'utf8');
    expect(stack).not.toMatch(/case '(POP_TO|REPLACE)'/);
    expect(stack).toMatch(/default: \{\s*return original\.getStateForAction\(state, action, options\);/);
  });
});
