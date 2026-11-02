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
  routes: readonly { name: string; params?: object; state?: NavigationStateLike }[];
};

/**
 * The screen in front as a path to come back to, for the sign-ins nothing on
 * screen asked for (the session ended elsewhere, or a guest's was merged).
 * Built as expo-router's own pathname is, from the focused route at every
 * level (groups and a last `index` left out, dynamic segments filled from the
 * params), but from the params React Navigation holds, decoded once, each
 * encoded once as a push writes it, and the rest as the query: `usePathname()`
 * has no query, and expo-router's route info decodes every param a second time
 * (`build/global-state/routeInfo.js`). Expo Router's own params, such as the
 * zoom a screen opened with, stay out, as they do from its paths. Null with no
 * screen in front, or on a page the app does not have.
 */
export function focusedRouteReturnPath(state: NavigationStateLike | null | undefined): string | null {
  const segments: string[] = [];
  const params: Record<string, unknown> = {};
  let route = state?.routes[state.index ?? 0];
  if (!route) return null;
  while (route) {
    if (route.name !== '__root') segments.push(...route.name.replace(/^\//, '').split('/'));
    // A navigator's route names the screen it was sent to and that screen's
    // params, which the screen's own route holds as well.
    const { screen, params: screenParams, ...own } = (route.params ?? {}) as Record<string, unknown>;
    Object.assign(params, removeInternalExpoRouterParams(own));
    route = route.state
      ? route.state.routes[route.state.index ?? 0]
      // A navigator that has not drawn its screens yet has no state of its own.
      : typeof screen === 'string'
        ? { name: screen, params: typeof screenParams === 'object' && screenParams ? screenParams : undefined }
        : undefined;
  }
  if (segments.at(-1) === 'index') segments.pop();

  const pathParams = new Set<string>();
  const path: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith('(') && segment.endsWith(')')) continue;
    if (segment === '+not-found' || segment === '_sitemap') return null;
    const dynamic = /^\[(?:\.\.\.)?(.+)\]$/.exec(segment)?.[1];
    if (!dynamic) {
      path.push(encodeURIComponent(segment));
      continue;
    }
    pathParams.add(dynamic);
    path.push(...paramValues(params[dynamic]).filter(Boolean).map(encodeURIComponent));
  }

  const query = Object.entries(params)
    .filter(([key]) => !pathParams.has(key))
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
