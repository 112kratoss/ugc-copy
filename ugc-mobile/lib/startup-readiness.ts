import type { OnboardingStatus } from './types';

export const STARTUP_VERSION_CHECK_FALLBACK_MS = 4_000;

export type StartupVersionCheckStatus = 'idle' | 'pending' | 'redirecting' | 'settled';

/**
 * StartupCoordinator keeps its cover over home until the onboarding redirect
 * has landed; a redirect that has not landed by then stops holding it.
 */
export const STARTUP_REDIRECT_FALLBACK_MS = 3_000;

/** The param the launch redirect gives onboarding, which then arrives without its fade. */
export const ONBOARDING_LAUNCH_ENTRY = 'launch';

export type OnboardingRedirectInput = {
  isHydrated: boolean;
  isAuthLoading: boolean;
  hasUser: boolean;
  storageAvailable: boolean;
  versionCheckStatus: StartupVersionCheckStatus;
  pathname: string;
  onboardingStatus: OnboardingStatus;
};

/** Whether a launch on home is due to be sent to onboarding: a first run, not yet finished or skipped. */
export function isOnboardingRedirectDue({
  isHydrated,
  isAuthLoading,
  hasUser,
  storageAvailable,
  versionCheckStatus,
  pathname,
  onboardingStatus,
}: OnboardingRedirectInput): boolean {
  return (
    isHydrated &&
    !isAuthLoading &&
    !hasUser &&
    storageAvailable &&
    versionCheckStatus !== 'redirecting' &&
    pathname === '/' &&
    (onboardingStatus === 'not_started' || onboardingStatus === 'in_progress')
  );
}

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
