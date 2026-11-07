import { normalizeAuthReturnTo } from './auth-navigation';

/**
 * The sign-up sheet (`app/join.tsx`): what a guest is asked when they reach
 * for something an account does (owner, 2026-11-08: Create, Generate, Remix,
 * Like, Follow). Signing up there goes on to the creator name and the welcome
 * credits once, then back to `returnTo`.
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
