import { useQuery, type QueryClient } from '@tanstack/react-query';

import { useAuth } from './auth';
import { useOnboarding } from './onboarding';
import {
  isIdentityDeferredInMetadata,
  resolveOnboardingDestination,
  type OnboardingDestination,
} from './onboarding-destination';
import type { WelcomeCreditResponse } from './types';

const WELCOME_CREDITS_QUERY_SCOPE = 'welcome-credits';

/** The account-scoped key every welcome-credit reader shares. */
export function welcomeCreditsQueryKey(userId: string | undefined) {
  return [WELCOME_CREDITS_QUERY_SCOPE, userId] as const;
}

/**
 * Teach the shared query a response some screen just fetched first-hand.
 *
 * The onboarding screen fetches welcome credits on its own, and until it wrote
 * the answer back here the Home and Settings cards kept the copy they took at
 * sign-in. A creator who had just saved a handle walked back to a card still
 * headlined "Finish your creator setup", tapped it, and watched the flow open,
 * learn there was nothing left to do, and bounce straight back out — until a
 * refetch happened to land and the card vanished on its own. Seeding the cache
 * costs no request and moves every entry point in the same frame.
 */
export function primeWelcomeCredits(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  userId: string,
  welcome: WelcomeCreditResponse,
) {
  queryClient.setQueryData(welcomeCreditsQueryKey(userId), welcome);
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
 * The resume card mounts in two places at once (Home and Settings) and
 * `getWelcomeCredits` is uncached in the API client, so the previous
 * per-component `useEffect` fetch fired the same request twice on every launch.
 * A single query key collapses them and lets the foreground refetch — wired to
 * AppState in `app/_layout.tsx` — keep every consumer in step for free.
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
    queryFn: () => api.getWelcomeCredits(),
    // An answer that can no longer lead anywhere is not asked again on every
    // return to the app (330 requests a week, from Home's card): once read per
    // launch, and again only when Edit Profile or a claimed name invalidates it.
    staleTime: (query) => (isWelcomeCreditAnswerSettled(query.state.data) ? Infinity : WELCOME_CREDITS_STALE_MS),
  });
}

const WELCOME_CREDITS_STALE_MS = 1000 * 60;

/**
 * Statuses an account does not leave (the server's `loadWelcomeCreditStatus`,
 * in `src/lib/onboarding-route-adapter-service.ts`): claimed, or created before
 * the program. Not `not_eligible`, which turns `eligible` once the creator name
 * is done, nor `unavailable`, which turns back when the program does.
 */
const SETTLED_WELCOME_STATUSES: ReadonlySet<WelcomeCreditResponse['status']> = new Set([
  'claimed',
  'already_claimed',
  'legacy_ineligible',
  'identity_already_claimed',
] as const);

/**
 * Whether a welcome answer leaves the setup entry points with nothing to offer
 * for good: the creator name is done and the credits can no longer be claimed.
 * The balance it carries is never read from here.
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
    welcome: welcomeQuery.data ?? null,
    local: state,
    identityDeferredOnAccount: isIdentityDeferredInMetadata(user?.user_metadata),
  });
}
