/**
 * Navigation states as expo-router 55 holds them, for the return a forced
 * sign-in builds from the screen in front (`focusedRouteReturnPath`). The shape
 * is what `navigationRef.getRootState()` returned on the iPhone simulator: the
 * `__root` slot, Home's tabs under every screen pushed on the root stack, and
 * each route's params as React Navigation keeps them, decoded once.
 *
 * A pushed route's params come from expo-router's own code for both ends of the
 * push: `resolveHref` writes the path, and it is read back as `getStateFromPath`
 * reads one, each dynamic segment decoded once and the query by
 * `parseQueryParams`.
 *
 * A navigator's own route keeps params too, which a state here holds only when
 * a case gives them: expo-router copies the params of the screen it sends a
 * navigator to onto the navigator's route (`getPayloadFromStateRoute` in
 * `build/global-state/routing.js`), where they stay after another of its
 * screens comes in front, and a link opened while the app runs leaves React
 * Navigation's (`initial`, `path`…) on `__root`.
 */
import { parseQueryParams, safelyDecodeURIComponent } from 'expo-router/build/fork/getStateFromPath-forks';
import { resolveHref } from 'expo-router/build/link/href';

import type { NavigationStateLike } from '../../lib/auth-navigation';

export type StateFixture = NavigationStateLike;
/** A route, with the key React Navigation gives it where a case reads one. */
export type RouteFixture = NavigationStateLike['routes'][number] & { key?: string };

/** Everything a return can lose on the way: & and # would cut it, + turn to a space, % be read again, \ and a line break send it Home. */
export const AWKWARD_PROMPT = 'A dancer & a drum #2 + 100% real \\ one\nline two';

/** The route `router.push({ pathname, params })` puts on screen, e.g. `create/[tool]`. */
export function pushedRoute(pathname: string, params: Record<string, string>): RouteFixture {
  // Any route's pathname, which typed routes (`.expo/types`) cannot name.
  const href = resolveHref({ pathname, params } as never);
  const written = new URL(href, 'file:').pathname.split('/');
  const pathParams = Object.fromEntries(pathname.split('/').flatMap((segment, index) => {
    const name = /^\[(.+)\]$/.exec(segment)?.[1];
    return name ? [[name, safelyDecodeURIComponent(written[index])]] : [];
  }));
  const name = pathname.replace(/^\//, '');
  return { name, params: { ...pathParams, ...parseQueryParams(href, { name }) } };
}

/** Home's tabs with `tab` in front (Home itself by default), and the params the tabs' own route keeps. */
export function homeTabs(tab: RouteFixture = { name: 'index' }, params?: Record<string, unknown>): RouteFixture {
  const tabs = ['index', 'creator', 'studio', 'showcase', 'pricing', 'profile'].map((name) => (name === tab.name ? tab : { name }));
  return { name: '(tabs)', ...(params ? { params } : {}), state: { index: tabs.indexOf(tab), routes: tabs } };
}

/** The root state with these routes on the root stack, the last one in front. */
export function rootStateWith(...routes: RouteFixture[]): StateFixture {
  return { index: 0, routes: [{ name: '__root', state: { index: routes.length - 1, routes } }] };
}

/** The root state with `route` pushed over Home, or Home alone. */
export function stateInFront(route?: RouteFixture): StateFixture {
  return route ? rootStateWith(homeTabs(), route) : rootStateWith(homeTabs());
}
