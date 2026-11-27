import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { transformSync } from '@babel/core';
import { StackRouter, type ParamListBase, type StackNavigationState } from '@react-navigation/routers';
import { describe, expect, it } from 'vitest';

import { reelLeaveFor } from '@/lib/reel-leave';

// Review of #947: an Android close keeps the reel's route until the picture
// has landed, up to half a second after Back, and went back from whatever was
// on top by then: a screen pushed meanwhile was popped in the reel's place.
describe('reelLeaveFor', () => {
  const stack = (index: number, ...keys: string[]) => ({ key: 'root', index, routes: keys.map((key) => ({ key })) });

  it('goes back the usual way while the reel is in front', () => {
    expect(reelLeaveFor(stack(1, 'tabs', 'reel'), 'reel')).toEqual({ kind: 'back' });
    // A reel that is the first screen: the usual way is Explore in its place.
    expect(reelLeaveFor(stack(0, 'reel'), 'reel')).toEqual({ kind: 'back' });
  });

  it('takes the reel out by its key from under a screen pushed while it closed', () => {
    expect(reelLeaveFor(stack(2, 'tabs', 'reel', 'auth'), 'reel')).toEqual({
      kind: 'dispatch',
      action: { type: 'POP', payload: { count: 1 }, source: 'reel', target: 'root' },
    });
  });

  it('puts Explore in the place of a first-screen reel under such a screen', () => {
    expect(reelLeaveFor(stack(1, 'reel', 'auth'), 'reel')).toEqual({
      kind: 'dispatch',
      action: { type: 'REPLACE', payload: { name: '(tabs)', params: { screen: 'showcase' } }, source: 'reel', target: 'root' },
    });
  });

  it('does nothing once the reel is gone from its stack', () => {
    expect(reelLeaveFor(stack(1, 'tabs', 'creator'), 'reel')).toEqual({ kind: 'gone' });
  });

  it('goes back the usual way when the stack cannot be read', () => {
    expect(reelLeaveFor(undefined, 'reel')).toEqual({ kind: 'back' });
  });
});

const mobileRoot = path.resolve(__dirname, '..');
const requireFromMobile = createRequire(path.join(mobileRoot, 'package.json'));
const stackClientPath = path.join(mobileRoot, 'node_modules/expo-router/build/layouts/StackClient.js');

type StackState = StackNavigationState<ParamListBase>;
type StackRouterType = ReturnType<typeof StackRouter>;
type StackRouterAction = Parameters<StackRouterType['getStateForAction']>[1];
type StackRouterOverride = (original: StackRouterType) => Partial<StackRouterType>;

/**
 * Expo Router's own stack router override, the file that ships, its JSX
 * compiled as the app's Babel compiles it, over stand-ins for the views and
 * navigators it builds and the real `StackRouter` that `@react-navigation/native`
 * hands it. Its router code is the module's own; only what draws is stood in.
 */
function loadStackRouterOverride(): { source: string; stackRouterOverride: StackRouterOverride } {
  const source = readFileSync(stackClientPath, 'utf8');
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: stackClientPath,
    plugins: [[requireFromMobile.resolve('@babel/plugin-transform-react-jsx'), {
      pragma: 'react_1.default.createElement',
      pragmaFrag: 'react_1.default.Fragment',
    }]],
  })!;
  const requireFromStackClient = createRequire(stackClientPath);
  const standIns: Record<string, unknown> = {
    react: requireFromStackClient('react'),
    'nanoid/non-secure': requireFromStackClient('nanoid/non-secure'),
    '@react-navigation/native': { StackRouter },
    '../navigationParams': requireFromStackClient('../navigationParams'),
    '../fork/native-stack/createNativeStackNavigator': { createNativeStackNavigator: () => ({ Navigator: () => null }) },
    './withLayoutContext': { withLayoutContext: (navigator: unknown) => navigator },
    '../link/preview/LinkPreviewContext': {},
    '../useScreens': {},
    './stack-utils': {},
    '../utils/children': {},
    '../views/Protected': {},
  };
  const loaded = { exports: {} as { stackRouterOverride?: StackRouterOverride } };
  const load = (specifier: string) => {
    if (!(specifier in standIns)) throw new Error(`StackClient.js asked for ${specifier}, which this test has no stand-in for.`);
    return standIns[specifier];
  };
  new Function('require', 'module', 'exports', code!)(load, loaded, loaded.exports);
  if (!loaded.exports.stackRouterOverride) throw new Error('StackClient.js no longer exports stackRouterOverride.');
  return { source, stackRouterOverride: loaded.exports.stackRouterOverride };
}

// The reel's leave run through the router the app's root stack is built with:
// React Navigation's StackRouter with Expo Router's override laid over it, as
// `useNavigationBuilder` lays the root `Stack`'s `UNSTABLE_router` (review of
// #947). The action objects alone could pass while the router did something
// else with them.
describe("the reel's leave, through the root stack's router", () => {
  const { source, stackRouterOverride } = loadStackRouterOverride();
  const original = StackRouter({});
  const router: StackRouterType = { ...original, ...stackRouterOverride(original) };
  const ROOT_ROUTES = ['(tabs)', 'viewer', 'auth', 'creators/[username]'];

  function rootStack(routes: { key: string; name: string }[], routeNames = ROOT_ROUTES): StackState {
    return { stale: false, type: 'stack', key: 'root-stack', index: routes.length - 1, routeNames, routes, preloadedRoutes: [] };
  }

  function apply(state: StackState) {
    const leave = reelLeaveFor(state, 'reel');
    if (leave.kind !== 'dispatch') throw new Error(`expected an action, got ${leave.kind}`);
    return router.getStateForAction(state, leave.action as StackRouterAction, {
      routeNames: state.routeNames,
      routeParamList: {},
      routeGetIdList: {},
    }) as StackState | null;
  }

  it('is the router the root stack is given', () => {
    expect(source).toContain('UNSTABLE_router={exports.stackRouterOverride}');
  });

  it('takes out only the reel from under a screen pushed while it closed, and keeps that screen in front', () => {
    const next = apply(rootStack([
      { key: 'tabs', name: '(tabs)' },
      { key: 'reel', name: 'viewer' },
      { key: 'sign-in', name: 'auth' },
    ]));

    expect(next?.routes.map((route) => route.key)).toEqual(['tabs', 'sign-in']);
    expect(next?.index).toBe(1);
  });

  it("gives a first-screen reel's place to the tabs, opened on Explore, and keeps the screen in front", () => {
    const next = apply(rootStack([
      { key: 'reel', name: 'viewer' },
      { key: 'sign-in', name: 'auth' },
    ]));

    expect(next?.routes).toHaveLength(2);
    expect(next?.routes[0]).toMatchObject({ name: '(tabs)', params: { screen: 'showcase' } });
    expect(next?.routes[1]?.key).toBe('sign-in');
    expect(next?.index).toBe(1);
  });

  // The refusal is silent: React Navigation takes a router's null for an
  // action addressed to its own stack as handled (`useOnAction`), and the
  // reel would stay in front, out of sight and taking every touch. Only a
  // stack with no `(tabs)` route refuses it, and the app's root stack has one,
  // pinned below; a POP cannot be refused, the reel being in the stack and
  // above its first place whenever `reelLeaveFor` sends one.
  it('is refused only by a stack with no (tabs) route', () => {
    const withoutTabs = rootStack([
      { key: 'reel', name: 'viewer' },
      { key: 'sign-in', name: 'auth' },
    ], ['viewer', 'auth']);
    expect(apply(withoutTabs)).toBeNull();
  });

  it('can count on (tabs) being a route of the root stack, with nothing guarding it', () => {
    expect(existsSync(path.join(mobileRoot, 'app/(tabs)/_layout.tsx'))).toBe(true);
    expect(existsSync(path.join(mobileRoot, 'app/(tabs)/showcase.tsx'))).toBe(true);
    const layout = readFileSync(path.join(mobileRoot, 'app/_layout.tsx'), 'utf8');
    const tabs = layout.indexOf('<Stack.Screen name="(tabs)"');
    expect(tabs).toBeGreaterThan(-1);
    // Not inside a `Stack.Protected` whose guard could take it out of the stack.
    const before = layout.slice(0, tabs);
    expect(before.split('<Stack.Protected').length).toBe(before.split('</Stack.Protected>').length);
  });
});
