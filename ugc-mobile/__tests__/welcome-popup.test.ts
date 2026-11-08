import { beforeEach, describe, expect, it } from 'vitest';

import {
  dismissWelcomePopupThisRun,
  resetWelcomePopupThisRun,
  shouldShowWelcomePopup,
  wasWelcomePopupDismissedThisRun,
  welcomeCountUpTicks,
} from '../lib/welcome-popup';

describe('when the welcome-credits popup shows over Home (owner 11-09)', () => {
  const eligible = { status: 'eligible' as const, identityComplete: true };
  const base = { signedIn: true, welcome: eligible, homeFocused: true, dismissed: false };

  beforeEach(() => resetWelcomePopupThisRun());

  it('offers claimable credits to a named, signed-in account on Home', () => {
    expect(shouldShowWelcomePopup(base)).toBe(true);
  });

  it('stays away otherwise', () => {
    expect(shouldShowWelcomePopup({ ...base, signedIn: false })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, homeFocused: false })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, welcome: null })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, welcome: { ...eligible, identityComplete: false } })).toBe(false);
    for (const status of ['claimed', 'already_claimed', 'identity_already_claimed', 'legacy_ineligible', 'unavailable', 'not_eligible'] as const) {
      expect(shouldShowWelcomePopup({ ...base, welcome: { ...eligible, status } })).toBe(false);
    }
  });

  it('remembers a close until the next app start, for that account only', () => {
    expect(wasWelcomePopupDismissedThisRun('a')).toBe(false);
    dismissWelcomePopupThisRun('a');
    expect(wasWelcomePopupDismissedThisRun('a')).toBe(true);
    expect(wasWelcomePopupDismissedThisRun('b')).toBe(false);
    expect(wasWelcomePopupDismissedThisRun(null)).toBe(false);
  });
});

describe('the haptic ticks while the credits count up', () => {
  it('ticks every five credits on the way up, leaving the last to the success haptic', () => {
    expect(welcomeCountUpTicks(25)).toEqual([5, 10, 15, 20]);
    expect(welcomeCountUpTicks(5)).toEqual([]);
    expect(welcomeCountUpTicks(12, 4)).toEqual([4, 8]);
  });
});
