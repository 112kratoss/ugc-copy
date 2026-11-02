import { INTERNAL_SLOT_NAME, NOT_FOUND_ROUTE_NAME, SITEMAP_ROUTE_NAME } from 'expo-router/build/constants';
import { matchDynamicName } from 'expo-router/build/matchers';
import { removeInternalExpoRouterParams } from 'expo-router/build/navigationParams';

type AuthRouter<Href> = {
  canGoBack?: () => boolean;
  back: () => void;
  dismissTo?: (href: Href) => void;
  replace: (href: Href) => void;
};

/** A React Navigation state, as far as `focusedRouteReturnPath` reads it. */
export type NavigationStateLike = {
  index?: number;
  routes: readonly { key?: string; name: string; params?: object; state?: NavigationStateLike }[];
};

/** React Navigation's words for steering a nested navigator: never a screen's own params. */
const NAVIGATION_PARAM_KEYS = new Set(['screen', 'params', 'initial', 'state', 'path', 'merge', 'pop']);

/**
 * A shared link's surface, whose presence makes the post page count the open
 * as a share visit (`app/post/[id].tsx`). In-app links never carry it, the
 * page's own sign-in return included.
 */
const SHARE_SURFACE_PARAM = 's';

/** The returns screens gave for themselves, by the key of their route (`publishScreenReturn`). */
const screenReturns = new Map<string, string>();

/**
 * Gives the path a forced sign-in comes back to while the route `routeKey` is
 * in front, in place of the one `focusedRouteReturnPath` builds from its
 * params: for a screen whose params say where it opened, not where the person
 * has moved since, as the reel's `initialId` names the post it opened on. The
 * function returned takes it back, unless a later one has replaced it.
 */
export function publishScreenReturn(routeKey: string, path: string) {
  screenReturns.set(routeKey, path);
  return () => {
    if (screenReturns.get(routeKey) === path) screenReturns.delete(routeKey);
  };
}

/**
 * The screen in front as a path to come back to, for the sign-ins nothing on
 * screen asked for (the session ended elsewhere, or a guest's was merged).
 * The path is built as expo-router builds its own pathname, from the focused
 * route at every level (the `__root` slot, groups and a last `index` left out,
 * dynamic segments filled), and the query from the screen's own params: those
 * React Navigation holds for the route in front, decoded once, each encoded
 * once as a push writes it. `usePathname()` has no query, and expo-router's
 * route info decodes every param a second time and folds in the params each
 * navigator above the screen keeps (`build/global-state/routeInfo.js`): those
 * of the screen it was last sent to, whichever is in front now, and a link's on
 * the `__root` slot. Expo Router's own params, such as the zoom a screen opened
 * with, stay out, as they do from its paths. Null with no screen in front, or
 * on a page the app does not have. A screen that gave its own return for its
 * route (`publishScreenReturn`) comes back on that instead.
 */
export function focusedRouteReturnPath(state: NavigationStateLike | null | undefined): string | null {
  const names: string[] = [];
  let route = state?.routes[state.index ?? 0];
  let params: Record<string, unknown> = {};
  let routeKey: string | undefined;
  if (!route) return null;
  while (route) {
    if (route.name !== INTERNAL_SLOT_NAME) names.push(...route.name.replace(/^\//, '').split('/'));
    params = (route.params ?? {}) as Record<string, unknown>;
    routeKey = route.key;
    if (route.state) {
      route = route.state.routes[route.state.index ?? 0];
    } else if (typeof params.screen === 'string') {
      // A navigator that has not drawn its screens yet names one in its params.
      const screenParams = typeof params.params === 'object' && params.params ? params.params : undefined;
      route = { name: params.screen, params: screenParams };
    } else {
      route = undefined;
    }
  }
  const given = routeKey === undefined ? undefined : screenReturns.get(routeKey);
  if (given) return given;
  if (names.at(-1) === 'index') names.pop();

  const own = removeInternalExpoRouterParams(params) as Record<string, unknown>;
  const pathParams = new Set<string>();
  const path: string[] = [];
  for (const name of names) {
    if (name.startsWith('(') && name.endsWith(')')) continue;
    if (name === NOT_FOUND_ROUTE_NAME || name === SITEMAP_ROUTE_NAME) return null;
    const dynamic = matchDynamicName(name);
    if (!dynamic) {
      path.push(encodeURIComponent(name));
      continue;
    }
    pathParams.add(dynamic.name);
    path.push(...paramValues(own[dynamic.name]).filter(Boolean).map(encodeURIComponent));
  }

  const query = Object.entries(own)
    .filter(([key]) => !pathParams.has(key) && !NAVIGATION_PARAM_KEYS.has(key) && key !== SHARE_SURFACE_PARAM)
    .flatMap(([key, value]) => paramValues(value).map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`))
    .join('&');
  return `/${path.join('/')}${query ? `?${query}` : ''}`;
}

/** A param as text: a list's items, a number or a flag as written; nothing for an object or an empty value. */
function paramValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => (
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? [String(item)] : []
  ));
}

export function normalizeAuthReturnTo(value: string | string[] | null | undefined) {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  if (
    !candidate
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }

  return candidate;
}

export function completeAuthScreen<Href>(
  router: AuthRouter<Href>,
  returnTo: string | string[] | null | undefined
) {
  const destination = (normalizeAuthReturnTo(returnTo) ?? '/(tabs)') as unknown as Href;

  if (router.dismissTo) {
    router.dismissTo(destination);
    return;
  }

  router.replace(destination);
}

export function leaveAuthScreen<Href>(router: AuthRouter<Href>) {
  if (router.canGoBack?.()) {
    router.back();
    return;
  }

  router.replace('/(tabs)' as unknown as Href);
}
