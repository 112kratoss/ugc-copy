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
 * Where a sign-in by Apple or Google on the email form goes: as from the sign-in page, on to
 * the creator name and the welcome credits once (an account already set up passes straight
 * through), then the return. A return that is onboarding already, as the guest's sign-in page
 * hands the form, is used as it is.
 */
export function providerSignInHref(returnTo: string | string[] | undefined) {
  const route = normalizeAuthReturnTo(returnTo) ?? '/(tabs)';
  if (route === '/onboarding' || route.startsWith('/onboarding?')) return route;
  return { pathname: '/onboarding', params: { returnTo: route } } as const;
}
