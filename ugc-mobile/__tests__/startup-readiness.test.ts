import { describe, expect, it } from 'vitest';

import {
  isOnboardingRedirectDue,
  isStartupInteractiveReady,
  ONBOARDING_LAUNCH_ENTRY,
  onboardingAnimation,
  STARTUP_REDIRECT_FALLBACK_MS,
  STARTUP_VERSION_CHECK_FALLBACK_MS,
  type OnboardingRedirectInput,
  type StartupVersionCheckStatus,
} from '../lib/startup-readiness';

const firstRunOnHome: OnboardingRedirectInput = {
  isHydrated: true,
  isAuthLoading: false,
  hasUser: false,
  storageAvailable: true,
  versionCheckStatus: 'pending',
  pathname: '/',
  onboardingStatus: 'not_started',
};

describe('the launch redirect to onboarding', () => {
  it('is due for a first run still on home, once auth and onboarding are restored', () => {
    expect(isOnboardingRedirectDue(firstRunOnHome)).toBe(true);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, onboardingStatus: 'in_progress' })).toBe(true);
  });

  it('is not due before restoration, for an account, off home, or once onboarding is done with', () => {
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, isHydrated: false })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, isAuthLoading: true })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, hasUser: true })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, storageAvailable: false })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, versionCheckStatus: 'redirecting' })).toBe(false);
    // The redirect has landed: the path has left home.
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, pathname: '/onboarding' })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, onboardingStatus: 'skipped' })).toBe(false);
    expect(isOnboardingRedirectDue({ ...firstRunOnHome, onboardingStatus: 'completed' })).toBe(false);
  });

  it('arrives without a fade, and onboarding opened any other way fades in', () => {
    expect(onboardingAnimation({ entry: ONBOARDING_LAUNCH_ENTRY })).toBe('none');
    expect(onboardingAnimation(undefined)).toBe('fade');
    expect(onboardingAnimation({})).toBe('fade');
    expect(onboardingAnimation({ entry: 'settings' })).toBe('fade');
  });

  it('never holds the cover for long', () => {
    expect(STARTUP_REDIRECT_FALLBACK_MS).toBeGreaterThan(0);
    expect(STARTUP_REDIRECT_FALLBACK_MS).toBeLessThanOrEqual(5_000);
  });
});

const settledStartup = {
  isAuthLoading: false,
  isOnboardingHydrated: true,
  onboardingRedirectPending: false,
  versionCheckStatus: 'settled' as StartupVersionCheckStatus,
};

describe('mobile startup readiness', () => {
  it('waits for auth, onboarding hydration, and any onboarding redirect', () => {
    expect(isStartupInteractiveReady({ ...settledStartup, isAuthLoading: true })).toBe(false);
    expect(
      isStartupInteractiveReady({ ...settledStartup, isOnboardingHydrated: false })
    ).toBe(false);
    expect(
      isStartupInteractiveReady({ ...settledStartup, onboardingRedirectPending: true })
    ).toBe(false);
  });

  it.each<StartupVersionCheckStatus>(['idle', 'pending', 'redirecting'])(
    'does not report interactivity while the version check is %s',
    (versionCheckStatus) => {
      expect(isStartupInteractiveReady({ ...settledStartup, versionCheckStatus })).toBe(false);
    }
  );

  it('reports readiness only after startup routing and the version check settle', () => {
    expect(isStartupInteractiveReady(settledStartup)).toBe(true);
  });

  it('keeps the version-check fallback bounded', () => {
    expect(STARTUP_VERSION_CHECK_FALLBACK_MS).toBeGreaterThan(0);
    expect(STARTUP_VERSION_CHECK_FALLBACK_MS).toBeLessThanOrEqual(5_000);
  });
});
