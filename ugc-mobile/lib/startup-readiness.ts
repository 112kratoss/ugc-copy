export const STARTUP_VERSION_CHECK_FALLBACK_MS = 4_000;

export type StartupVersionCheckStatus = 'idle' | 'pending' | 'redirecting' | 'settled';

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
