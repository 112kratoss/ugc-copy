import { describe, expect, it, vi } from 'vitest';

import * as expoRouterNavigationParams from 'expo-router/build/navigationParams';
import { resolveHref } from 'expo-router/build/link/href';

import { completeAuthScreen, focusedRouteReturnPath, leaveAuthScreen, normalizeAuthReturnTo } from '../lib/auth-navigation';
import { homeTabs, pushedRoute, rootStateWith, type RouteFixture } from './fixtures/navigation-state';

describe('leaveAuthScreen', () => {
  it('uses navigation history when a back stack exists', () => {
    const router = {
      canGoBack: vi.fn(() => true),
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAuthScreen(router);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('returns to the tabs root when there is no back stack', () => {
    const router = {
      canGoBack: vi.fn(() => false),
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAuthScreen(router);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('auth return navigation', () => {
  it('accepts only local in-app return paths', () => {
    expect(normalizeAuthReturnTo('/creators/luna?tab=unlocks')).toBe('/creators/luna?tab=unlocks');
    expect(normalizeAuthReturnTo([' /creators/luna ', '/ignored'])).toBe('/creators/luna');
    expect(normalizeAuthReturnTo('https://example.com')).toBeNull();
    expect(normalizeAuthReturnTo('//example.com/path')).toBeNull();
    expect(normalizeAuthReturnTo('/creators\\luna')).toBeNull();
  });

  it('dismisses auth to a valid creator return path', () => {
    const router = {
      canGoBack: vi.fn(() => true),
      back: vi.fn(),
      dismissTo: vi.fn(),
      replace: vi.fn(),
    };

    completeAuthScreen(router, '/creators/luna');

    expect(router.dismissTo).toHaveBeenCalledWith('/creators/luna');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it('dismisses the whole auth flow to tabs when no safe return path exists', () => {
    const router = {
      canGoBack: vi.fn(() => false),
      back: vi.fn(),
      dismissTo: vi.fn(),
      replace: vi.fn(),
    };

    completeAuthScreen(router, 'https://example.com');

    expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it('falls back to replacing auth when dismissTo is unavailable', () => {
    const router = {
      canGoBack: vi.fn(() => true),
      back: vi.fn(),
      replace: vi.fn(),
    };

    completeAuthScreen(router, undefined);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('the screen in front, as a return', () => {
  const inFront = (route: RouteFixture) => focusedRouteReturnPath(rootStateWith(homeTabs(), route));

  it('is Home on Home, and a tab by its own name with its params', () => {
    expect(focusedRouteReturnPath(rootStateWith(homeTabs()))).toBe('/');
    expect(focusedRouteReturnPath(rootStateWith(homeTabs({ name: 'creator', params: { tool: 'video', guided: '1' } }))))
      .toBe('/creator?tool=video&guided=1');
  });

  // The tabs' own route keeps the params of the tab it was sent to.
  it('takes the params of the tab in front, not of one left behind', () => {
    const creator = { name: 'creator', params: { tool: 'video' } };
    const tabs = { name: '(tabs)', params: { screen: 'creator', params: creator.params }, state: { index: 0, routes: [{ name: 'index' }, creator] } };

    expect(focusedRouteReturnPath(rootStateWith(tabs))).toBe('/');
  });

  it('writes a pushed screen as its push did, each value encoded once', () => {
    const params = { tool: 'video', remix: 'gen-9', prompt: 'A dancer & a drum #2 + 100% real \\ one\nline two' };
    const path = inFront(pushedRoute('/create/[tool]', params));

    expect(path).toBe(resolveHref({ pathname: '/create/[tool]', params }));
    // A backslash or a line break, written raw, would be refused.
    expect(normalizeAuthReturnTo(path)).toBe(path);
  });

  it('encodes a path segment once, as expo-router decodes one', () => {
    expect(inFront(pushedRoute('/post/[id]', { id: 'a b/c?d#e' }))).toBe('/post/a%20b%2Fc%3Fd%23e');
  });

  it('follows a stack inside the root stack to the screen in front', () => {
    const post = { name: '[id]', params: { id: 'post-9', comments: 'post-9' } };
    const showcase = { name: 'showcase', params: { screen: '[id]', params: post.params }, state: { index: 0, routes: [post] } };

    expect(inFront(showcase)).toBe('/showcase/post-9?comments=post-9');
  });

  it('follows a navigator that has not drawn its screens yet to the screen its params name', () => {
    const tabs = { name: '(tabs)', params: { screen: 'creator', params: { tool: 'image' } } };

    expect(focusedRouteReturnPath(rootStateWith(tabs))).toBe('/creator?tool=image');
  });

  it('leaves out the params expo-router keeps for itself', () => {
    const own = Object.entries(expoRouterNavigationParams)
      .filter(([name]) => name.endsWith('_PARAM_NAME'))
      .map(([, name]) => [name as string, 'zoom|r1|post-9']);
    expect(own.length).toBeGreaterThan(0);

    expect(inFront({ name: 'viewer', params: { source: 'home', initialId: 'post-9', ...Object.fromEntries(own) } }))
      .toBe('/viewer?source=home&initialId=post-9');
  });

  it('writes a list once per item and a number as written, and leaves out what has no text', () => {
    const params = { tag: ['a', 'b'], page: 2, open: true, empty: undefined, draft: { id: 1 } };

    expect(inFront({ name: 'templates/index', params })).toBe('/templates?tag=a&tag=b&page=2&open=true');
  });

  it('has nothing to come back to without a screen, or on a page the app does not have', () => {
    expect(focusedRouteReturnPath(undefined)).toBeNull();
    expect(focusedRouteReturnPath(rootStateWith({ name: '+not-found', params: { 'not-found': ['nowhere'] } }))).toBeNull();
  });
});
