import { normalizeAuthReturnTo } from './auth-navigation';

/**
 * The sign-in page (`app/join.tsx`, `components/sign-in-wall.tsx`): what a guest
 * is asked when they reach for something an account does (owner, 2026-11-08:
 * Create, Generate, Remix, Like, Follow). Signing up there goes on to the
 * creator name and the welcome credits once, then back to `returnTo`.
 */
export const JOIN_ROUTE = '/join';

type Router = { push: (href: never) => void };

export function openSignUpSheet(router: Router, returnTo: string | null | undefined) {
  const route = normalizeAuthReturnTo(returnTo ?? undefined);
  router.push((route ? { pathname: JOIN_ROUTE, params: { returnTo: route } } : JOIN_ROUTE) as never);
}

/**
 * Whether making something asks this person to sign up first: anyone without
 * an account, unless they already hold credits (a guest who bought some keeps
 * creating with them, as before).
 */
export function signUpNeededToCreate({ hasUser, credits }: { hasUser: boolean; credits: number | null }) {
  if (hasUser) return false;
  return !(typeof credits === 'number' && credits > 0);
}

/** Where onboarding sends someone back to once the sign-up's steps are done. */
export function onboardingReturnTo(value: string | string[] | undefined): string | null {
  return normalizeAuthReturnTo(value) ?? null;
}

/**
 * Whether the sign-in route opens on its email form rather than the full-screen sign-in page:
 * only when the page's "Sign in with email" sent the person there. A redirect's notice ("You
 * were signed out") shows on the page, where Apple and Google are.
 */
export function signInOpensOnEmailForm(email: string | string[] | undefined) {
  return (Array.isArray(email) ? email[0] : email) === '1';
}

/**
 * Where a sign-in by Apple or Google goes, from either half of the sign-in page: on to the
 * creator name and the welcome credits once (an account already set up passes straight
 * through), then the return. A return that is onboarding itself (its own "Continue" asked for
 * an account) goes back to that screen, never a second onboarding over it. `inPlace` (a
 * redirect's sign-in that took a screen's place) rides along so onboarding puts it back there.
 */
export function providerSignInNext(
  target: string | string[] | undefined,
  inPlace = false,
): { kind: 'return'; route: string } | { kind: 'onboarding'; href: { pathname: '/onboarding'; params: Record<string, string> } } {
  const route = normalizeAuthReturnTo(target) ?? '/(tabs)';
  if (route === '/onboarding' || route.startsWith('/onboarding?')) return { kind: 'return', route };
  return {
    kind: 'onboarding',
    href: { pathname: '/onboarding', params: inPlace ? { returnTo: route, inPlace: '1' } : { returnTo: route } },
  };
}

/**
 * The page a sign-in goes back to once the creator setup is done, when the sign-in's return is a
 * fresh setup (`/onboarding?returnTo=…`, the sign-up page's email return in `app/join.tsx`);
 * `null` for any other return, `/onboarding` itself included (a setup already open beneath the
 * sign-in, which takes the account back). The query is read as `join.tsx` writes it: one
 * `encodeURIComponent`.
 */
export function creatorSetupReturn(href: string | string[] | undefined): string | null {
  const value = Array.isArray(href) ? href[0] : href;
  if (typeof value !== 'string') return null;
  const queryStart = value.indexOf('?');
  if (queryStart === -1 || value.slice(0, queryStart) !== '/onboarding') return null;
  for (const pair of value.slice(queryStart + 1).split('&')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator) !== 'returnTo') continue;
    try {
      return normalizeAuthReturnTo(decodeURIComponent(pair.slice(separator + 1))) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
