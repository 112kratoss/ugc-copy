import { useQuery } from '@tanstack/react-query';

import { useAuth } from './auth';
import { useOnboarding } from './onboarding';
import {
  resolveOnboardingDestination,
  type OnboardingDestination,
} from './onboarding-destination';
import type { WelcomeCreditResponse } from './types';

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
    queryKey: ['welcome-credits', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getWelcomeCredits(),
    staleTime: 1000 * 60,
  });
}

/**
 * Where the creator-setup entry points should lead, if anywhere.
 *
 * Returns `pending` until the welcome response lands, so callers render nothing
 * rather than guessing "nothing to do" from a request that has not finished.
 */
export function useOnboardingDestination(): OnboardingDestination {
  const { user } = useAuth();
  const { state } = useOnboarding();
  const welcomeQuery = useWelcomeCreditsQuery();

  return resolveOnboardingDestination({
    hasUser: Boolean(user),
    welcome: welcomeQuery.data ?? null,
    local: state,
  });
}
