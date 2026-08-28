import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';
import { useOnboarding } from '@/lib/onboarding';
import type { OnboardingStateResponse } from '@/lib/types';

/**
 * Teaches this install what the *account* already knows about onboarding.
 *
 * `getOnboardingState` shipped in the API client but was never called, so the
 * server was write-only and progress lived per install. The same person could
 * therefore finish onboarding on one device and be shown the guest welcome
 * screen on another — which is exactly what happened.
 *
 * Renders nothing; it exists to run the query and fold the result in. Kept out
 * of `OnboardingProvider.hydrate` on purpose: `isHydrated` gates a full-screen
 * cover during cold start, and joining the two would put the network on the
 * launch path. Kept out of `StartupCoordinator` because that already
 * coordinates three unrelated effects.
 *
 * The reconcile is promote-only — see `reconcileInstallOnboardingState`.
 */
export function OnboardingServerSync() {
  const { api, user } = useAuth();
  const { isHydrated, reconcileFromServer } = useOnboarding();

  const { data } = useQuery<OnboardingStateResponse>({
    queryKey: ['onboarding-state', user?.id],
    // Guests are entirely install-local. See `useWelcomeCreditsQuery` for why
    // reading account state for an anonymous session creates a launch loop.
    enabled: Boolean(user),
    queryFn: () => api.getOnboardingState(),
    staleTime: 1000 * 60,
  });

  useEffect(() => {
    // Waiting on hydration keeps the fold from racing the AsyncStorage read and
    // reconciling against the default state instead of this install's own.
    if (!data || !isHydrated) return;
    void reconcileFromServer({
      status: data.state.status,
      goal: data.state.goal,
      completedAt: data.state.completedAt,
    });
  }, [data, isHydrated, reconcileFromServer]);

  return null;
}
