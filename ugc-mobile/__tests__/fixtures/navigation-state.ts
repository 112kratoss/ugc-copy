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
 */
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';
import { resolveHref } from 'expo-router/build/link/href';

export type RouteFixture = { name: string; params?: Record<string, unknown>; state?: StateFixture };
export type StateFixture = { index?: number; routes: RouteFixture[] };

/** The route `router.push({ pathname, params })` puts on screen, e.g. `create/[tool]`. */
export function pushedRoute(pathname: string, params: Record<string, string>): RouteFixture {
  const href = resolveHref({ pathname, params });
  const written = new URL(href, 'file:').pathname.split('/');
  const pathParams = Object.fromEntries(pathname.split('/').flatMap((segment, index) => {
    const name = /^\[(.+)\]$/.exec(segment)?.[1];
    return name ? [[name, decodeURIComponent(written[index])]] : [];
  }));
  const name = pathname.replace(/^\//, '');
  return { name, params: { ...pathParams, ...parseQueryParams(href, { name } as never) } };
}

/** Home's tabs, with `tab` in front (Home itself by default). */
export function homeTabs(tab: RouteFixture = { name: 'index' }): RouteFixture {
  const tabs = ['index', 'showcase', 'creator', 'studio', 'profile'].map((name) => (name === tab.name ? tab : { name }));
  return { name: '(tabs)', state: { index: tabs.indexOf(tab), routes: tabs } };
}

/** The root state with these routes on the root stack, the last one in front. */
export function rootStateWith(...routes: RouteFixture[]): StateFixture {
  return { index: 0, routes: [{ name: '__root', state: { index: routes.length - 1, routes } }] };
}
