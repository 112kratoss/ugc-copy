import { describe, expect, it, vi } from 'vitest';

import * as expoRouterNavigationParams from 'expo-router/build/navigationParams';
import { resolveHref } from 'expo-router/build/link/href';

import {
  completeAuthScreen,
  focusedRouteReturnPath,
  frontRouteKey,
  leaveAuthScreen,
  normalizeAuthReturnTo,
  publishScreenReturn,
  signInNoticeRoute,
  tookReturnsPlace,
} from '../lib/auth-navigation';
import { AWKWARD_PROMPT, homeTabs, pushedRoute, rootStateWith, stateInFront } from './fixtures/navigation-state';

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

  it.each([
    ['its return', '/viewer?source=home&initialId=post-9', [], [['/viewer?source=home&initialId=post-9']]],
    ['no return', undefined, [['/(tabs)']], []],
    ['a return that is not the app\'s', 'https://example.com', [['/(tabs)']], []],
  ])('puts a sign-in that took the place of its return back with %s, or goes Home as any sign-in does', (_label, returnTo, dismissed, replaced) => {
    const router = { back: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() };

    completeAuthScreen(router, returnTo, { inPlace: true });

    expect(router.dismissTo.mock.calls).toEqual(dismissed);
    expect(router.replace.mock.calls).toEqual(replaced);
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
  it('is Home on Home, and a tab by its own name with its params', () => {
    expect(focusedRouteReturnPath(stateInFront())).toBe('/');
    expect(focusedRouteReturnPath(rootStateWith(homeTabs({ name: 'creator', params: { tool: 'video', guided: '1' } }))))
      .toBe('/creator?tool=video&guided=1');
  });

  // expo-router copies the params of the tab it sends the tabs to onto their
  // own route, as onboarding's guided video creator leaves it, and they stay
  // there; a tab press gives the tab in front no params of its own.
  it('takes no params from the tabs\' own route, which keeps those of the tab they were last sent to', () => {
    const sent = { tool: 'video', guided: '1' };
    const tabsParams = { ...sent, screen: 'creator', params: sent };

    expect(focusedRouteReturnPath(rootStateWith(homeTabs({ name: 'index' }, tabsParams)))).toBe('/');
    expect(focusedRouteReturnPath(rootStateWith(homeTabs({ name: 'creator' }, tabsParams)))).toBe('/creator');
    expect(focusedRouteReturnPath(rootStateWith(homeTabs({ name: 'showcase' }, tabsParams)))).toBe('/showcase');
  });

  // React Navigation's NAVIGATE for a link opened while the app runs, which stays on `__root`.
  it('takes nothing from a link left on the root slot', () => {
    const link = { username: 'luna', initial: false, screen: 'creators/[username]', path: '/creators/luna', params: { username: 'luna' } };
    const root = { name: '__root', params: link, state: { index: 0, routes: [homeTabs({ name: 'profile' })] } };

    expect(focusedRouteReturnPath({ index: 0, routes: [root] })).toBe('/profile');
  });

  it('writes a pushed screen as its push did, each value encoded once', () => {
    const params = { tool: 'video', remix: 'gen-9', prompt: AWKWARD_PROMPT };
    const path = focusedRouteReturnPath(stateInFront(pushedRoute('/create/[tool]', params)));

    expect(path).toBe(resolveHref({ pathname: '/create/[tool]', params }));
    // A backslash or a line break, written raw, would be refused.
    expect(normalizeAuthReturnTo(path)).toBe(path);
  });

  it('encodes a path segment once, as expo-router decodes one', () => {
    expect(focusedRouteReturnPath(stateInFront(pushedRoute('/post/[id]', { id: 'a b/c?d#e' })))).toBe('/post/a%20b%2Fc%3Fd%23e');
  });

  it('follows a stack inside the root stack to the screen in front', () => {
    const post = { name: '[id]', params: { id: 'post-9', comments: 'post-9' } };
    const showcase = { name: 'showcase', params: { ...post.params, screen: '[id]', params: post.params }, state: { index: 0, routes: [post] } };

    expect(focusedRouteReturnPath(stateInFront(showcase))).toBe('/showcase/post-9?comments=post-9');
  });

  it('follows a navigator that has not drawn its screens yet to the screen its params name', () => {
    const tabs = { name: '(tabs)', params: { tool: 'image', screen: 'creator', params: { tool: 'image', initial: false } } };

    expect(focusedRouteReturnPath(rootStateWith(tabs))).toBe('/creator?tool=image');
  });

  it('leaves out the params expo-router keeps for itself', () => {
    const own = Object.entries(expoRouterNavigationParams)
      .filter(([name]) => name.endsWith('_PARAM_NAME'))
      .map(([, name]) => [name as string, 'zoom|r1|post-9']);
    expect(own.length).toBeGreaterThan(0);

    expect(focusedRouteReturnPath(stateInFront({ name: 'viewer', params: { source: 'home', initialId: 'post-9', ...Object.fromEntries(own) } })))
      .toBe('/viewer?source=home&initialId=post-9');
  });

  // The post page counts an open carrying it as a share visit; in-app links never carry it.
  it('leaves out a shared link\'s surface, which would count the visit again', () => {
    expect(focusedRouteReturnPath(stateInFront(pushedRoute('/post/[id]', { id: 'post-9', s: 'whatsapp', comments: 'post-9' }))))
      .toBe('/post/post-9?comments=post-9');
  });

  it('writes a list once per item and a number as written, and leaves out what has no text', () => {
    const params = { tag: ['a', 'b'], page: 2, open: true, empty: undefined, draft: { id: 1 } };

    expect(focusedRouteReturnPath(stateInFront({ name: 'templates/index', params }))).toBe('/templates?tag=a&tag=b&page=2&open=true');
  });

  it('has nothing to come back to without a screen, or on a page the app does not have', () => {
    expect(focusedRouteReturnPath(undefined)).toBeNull();
    expect(focusedRouteReturnPath(rootStateWith({ name: '+not-found', params: { 'not-found': ['nowhere'] } }))).toBeNull();
  });
});

describe('a return the screen in front gave for itself', () => {
  const reel = pushedRoute('/viewer', { source: 'home', initialId: 'post-9' }, 'viewer-1');
  const swiped = '/viewer?source=home&initialId=post-14';

  it('is the return while that route is in front, and the one its params build once taken back', () => {
    const takeBack = publishScreenReturn('viewer-1', swiped);
    expect(focusedRouteReturnPath(stateInFront(reel))).toBe(swiped);

    takeBack();

    expect(focusedRouteReturnPath(stateInFront(reel))).toBe('/viewer?source=home&initialId=post-9');
  });

  it('is not the return of a screen pushed over it', () => {
    const takeBack = publishScreenReturn('viewer-1', swiped);

    expect(focusedRouteReturnPath(rootStateWith(homeTabs(), reel, pushedRoute('/creators/[username]', { username: 'luna' }, 'creators-1'))))
      .toBe('/creators/luna');

    takeBack();
  });

  it('stays the later of two, whatever order they are taken back in', () => {
    const takeBackFirst = publishScreenReturn('viewer-1', swiped);
    const takeBackSecond = publishScreenReturn('viewer-1', '/viewer?source=home&initialId=post-15');

    takeBackFirst();
    expect(focusedRouteReturnPath(stateInFront(reel))).toBe('/viewer?source=home&initialId=post-15');

    takeBackSecond();
    expect(focusedRouteReturnPath(stateInFront(reel))).toBe('/viewer?source=home&initialId=post-9');
  });
});

describe('the sign-in a forced sign-out opens', () => {
  it('carries the screen in front as its return, and whether sign-in took its place', () => {
    expect(signInNoticeRoute('signed-out', '/post/post-9', { inPlace: true }))
      .toEqual({ pathname: '/auth', params: { notice: 'signed-out', returnTo: '/post/post-9', inPlace: '1' } });
    expect(signInNoticeRoute('session-merged', '/post/post-9', { inPlace: false }))
      .toEqual({ pathname: '/auth', params: { notice: 'session-merged', returnTo: '/post/post-9' } });
  });

  it('has no return when the screen in front is not known, or is sign-in itself', () => {
    for (const screen of [null, 'https://example.com', '/auth', '/auth?returnTo=%2Fpost%2Fpost-9']) {
      expect(signInNoticeRoute('signed-out', screen, { inPlace: true })).toEqual({ pathname: '/auth', params: { notice: 'signed-out' } });
    }
  });

  it('is read back as it was written, and nothing else is', () => {
    const { params } = signInNoticeRoute('signed-out', '/post/post-9', { inPlace: true });

    expect(tookReturnsPlace('inPlace' in params ? params.inPlace : undefined)).toBe(true);
    expect(tookReturnsPlace(['1'])).toBe(true);
    expect(tookReturnsPlace(undefined)).toBe(false);
    expect(tookReturnsPlace('true')).toBe(false);
  });
});

describe('the route in front on the root stack', () => {
  it('is the root stack\'s own route: Home\'s tabs when a tab is in front', () => {
    const tabs = { key: 'tabs-1', ...homeTabs({ name: 'creator' }) };
    const post = { key: 'post-1', ...pushedRoute('/post/[id]', { id: 'post-9' }) };

    expect(frontRouteKey(rootStateWith(tabs))).toBe('tabs-1');
    expect(frontRouteKey(rootStateWith(tabs, post))).toBe('post-1');
  });

  it('is nothing without a state, or before the root stack is drawn', () => {
    expect(frontRouteKey(undefined)).toBeNull();
    expect(frontRouteKey({ routes: [{ name: '__root' }] })).toBeNull();
  });
});
