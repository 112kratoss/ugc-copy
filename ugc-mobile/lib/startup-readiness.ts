export const STARTUP_VERSION_CHECK_FALLBACK_MS = 4_000;

export type StartupVersionCheckStatus = 'idle' | 'pending' | 'redirecting' | 'settled';

/** The param the launch redirect gives onboarding, which then arrives without its fade. */
export const ONBOARDING_LAUNCH_ENTRY = 'launch';

/**
 * Onboarding's entrance: a fade when someone opens the flow, none when a
 * launch is sent there. Home is beneath it then, and a fade would show it.
 */
export function onboardingAnimation(params: object | undefined): 'none' | 'fade' {
  return (params as { entry?: unknown } | undefined)?.entry === ONBOARDING_LAUNCH_ENTRY ? 'none' : 'fade';
}

interface StartupInteractiveReadiness {
  isAuthLoading: boolean;
  isOnboardingHydrated: boolean;
  onboardingRedirectPending: boolean;
  versionCheckStatus: StartupVersionCheckStatus;
}

export function isStartupInteractiveReady({
  isAuthLoading,
  isOnboardingHydrated,
  onboardingRedirectPending,
  versionCheckStatus,
}: StartupInteractiveReadiness) {
  return (
    isOnboardingHydrated &&
    !isAuthLoading &&
    !onboardingRedirectPending &&
    versionCheckStatus === 'settled'
  );
}
