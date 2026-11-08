import { useQuery, type QueryClient } from '@tanstack/react-query';

import { useAuth } from './auth';
import { useOnboarding } from './onboarding';
import {
  isIdentityDeferredInMetadata,
  resolveOnboardingDestination,
  type OnboardingDestination,
} from './onboarding-destination';
import type { WelcomeCreditResponse } from './types';
import { rememberWelcomeAnswer } from './welcome-promise';

const WELCOME_CREDITS_QUERY_SCOPE = 'welcome-credits';

/** The account-scoped key every welcome-credit reader shares. */
export function welcomeCreditsQueryKey(userId: string | undefined) {
  return [WELCOME_CREDITS_QUERY_SCOPE, userId] as const;
}

/**
 * Teach the shared query a response some screen just fetched first-hand.
 *
 * The onboarding screen fetches welcome credits on its own. Writing the answer
 * back here keeps the start-up reopen (`components/setup-reopen.tsx`) from
 * judging a setup unfinished from the copy it took at sign-in (the removed
 * Home card once reopened a finished flow that way). Seeding the cache costs
 * no request. The phone learns the answer too: a claim stops the welcome-credit
 * promise to whoever is signed out here next (`lib/welcome-promise.ts`).
 */
export function primeWelcomeCredits(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  userId: string,
  welcome: WelcomeCreditResponse,
) {
  queryClient.setQueryData(welcomeCreditsQueryKey(userId), welcome);
  rememberWelcomeAnswer(welcome.status);
}

/**
 * Mark every account's welcome-credit answer stale.
 *
 * For writers that change the inputs without seeing the result: Edit Profile
 * can complete the creator identity, which is half of the answer, so a refetch
 * is the honest option there.
 */
export function invalidateWelcomeCredits(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  return queryClient.invalidateQueries({ queryKey: [WELCOME_CREDITS_QUERY_SCOPE] });
}

/**
 * One shared welcome-credits query.
 *
 * `getWelcomeCredits` is uncached in the API client; one query key shares a
 * single answer between the start-up reopen and onboarding's own writes, and
 * the foreground refetch wired to AppState in `app/_layout.tsx` keeps it fresh.
 *
 * `enabled: Boolean(user)` is the guest guard, and it is load-bearing rather
 * than an optimisation: `useAuth().user` is deliberately null for anonymous
 * sessions, and the startup coordinator force-redirects signed-out installs to
 * `/onboarding` whenever their status reads `not_started`. Letting a guest read
 * account state would hand them exactly that status and trap them in a launch
 * loop.
 */
export function useWelcomeCreditsQuery() {
  const { api, user } = useAuth();
  return useQuery<WelcomeCreditResponse>({
    queryKey: welcomeCreditsQueryKey(user?.id),
    enabled: Boolean(user),
    queryFn: async () => {
      const welcome = await api.getWelcomeCredits();
      // What the phone promises the next signed-out visitor follows the last
      // account it heard from (`lib/welcome-promise.ts`).
      rememberWelcomeAnswer(welcome.status);
      return welcome;
    },
    // An answer that can no longer lead anywhere is not asked again on every
    // return to the app (330 requests a week, from the old Home card): once read per
    // launch, and again only when Edit Profile or a claimed name invalidates it.
    staleTime: (query) => (isWelcomeCreditAnswerSettled(query.state.data) ? Infinity : WELCOME_CREDITS_STALE_MS),
  });
}

const WELCOME_CREDITS_STALE_MS = 1000 * 60;

/**
 * Statuses an account does not leave (the server's `loadWelcomeCreditStatus`,
 * in `src/lib/onboarding-route-adapter-service.ts`): the credits claimed, by
 * this account or by another of the same person. Not `not_eligible`, which
 * turns `eligible` once the creator name is done, nor `unavailable`, nor
 * `legacy_ineligible`, which the server also answers an account holding 25
 * credits or more while the program is off: either can turn `eligible` when it
 * comes back.
 */
const SETTLED_WELCOME_STATUSES: ReadonlySet<WelcomeCreditResponse['status']> = new Set([
  'claimed',
  'already_claimed',
  'identity_already_claimed',
] as const);

/**
 * Whether a welcome answer leaves the setup entry points with nothing to offer
 * for good: the creator name is done and the credits have been claimed. The
 * balance it carries is never read from here.
 */
export function isWelcomeCreditAnswerSettled(welcome: WelcomeCreditResponse | undefined): boolean {
  return Boolean(welcome?.identityComplete) && SETTLED_WELCOME_STATUSES.has(welcome!.status);
}

/**
 * Where the creator-setup entry points should lead, if anywhere.
 *
 * Returns `pending` until the welcome response lands, so callers render nothing
 * rather than guessing "nothing to do" from a request that has not finished.
 */
export function useOnboardingDestination(): OnboardingDestination {
  const { user, isLoading } = useAuth();
  const { state } = useOnboarding();
  const welcomeQuery = useWelcomeCreditsQuery();

  // A session still being read off the keychain is not a guest. Resolving
  // before it lands answers `intro` for every registered creator on every cold
  // start: the guest card's copy, for a moment, on an account holder's Home.
  if (isLoading) return 'pending';

  return resolveOnboardingDestination({
    hasUser: Boolean(user),
    userId: user?.id ?? null,
    welcome: welcomeQuery.data ?? null,
    local: state,
    identityDeferredOnAccount: isIdentityDeferredInMetadata(user?.user_metadata),
  });
}
