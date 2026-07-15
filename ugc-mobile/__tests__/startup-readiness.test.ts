import { describe, expect, it } from 'vitest';

import {
  isStartupInteractiveReady,
  STARTUP_VERSION_CHECK_FALLBACK_MS,
  type StartupVersionCheckStatus,
} from '../lib/startup-readiness';

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
