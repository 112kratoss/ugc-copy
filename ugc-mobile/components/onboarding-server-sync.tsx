import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { isIdentityDeferredOnAccount, useAuth } from '@/lib/auth';
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
  const { isHydrated, reconcileFromServer, state, update } = useOnboarding();

  // The fold only promotes: an install that has finished onboarding has nothing
  // left to learn from the account (a goal chosen elsewhere afterwards aside,
  // which only the flow reopened from Settings would show).
  const installFinished = state.status === 'completed' && Boolean(state.completedAt);
  const { data } = useQuery<OnboardingStateResponse>({
    queryKey: ['onboarding-state', user?.id],
    // Guests are entirely install-local. See `useWelcomeCreditsQuery` for why
    // reading account state for an anonymous session creates a launch loop.
    // Asked once the install's own state is read, and not by a finished one.
    enabled: Boolean(user) && isHydrated && !installFinished,
    queryFn: () => api.getOnboardingState(),
    // Once a launch. What it promotes is read only while the install is signed
    // out (the launch redirect, a guest's setup card), never within a minute of
    // a return to the app, which re-read it every minute (282 requests a week).
    staleTime: Infinity,
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

  // The account's "Set up later" (chosen on the web or on another device) is
  // kept in this install's own record as well (02-11). Written once, since the
  // record stops it, and only after hydration, so it never lands on the
  // default state.
  const deferredOnAccount = isIdentityDeferredOnAccount(user);
  const deferredOnInstall = Boolean(state.identityDeferredAt);
  useEffect(() => {
    if (!isHydrated || !deferredOnAccount || deferredOnInstall) return;
    void update({ identityDeferredAt: new Date().toISOString() });
  }, [deferredOnAccount, deferredOnInstall, isHydrated, update]);

  return null;
}
