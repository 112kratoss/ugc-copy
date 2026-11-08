import { beforeEach, describe, expect, it } from 'vitest';

import {
  dismissWelcomePopupThisRun,
  resetWelcomePopupThisRun,
  shouldShowWelcomePopup,
  wasWelcomePopupDismissedThisRun,
  WELCOME_COUNT_UP_MS,
  welcomeCountUpTicks,
  welcomeFillProgress,
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

describe('the fill while the credits count up (owner 11-09: "like games with filling animations")', () => {
  it('ticks a haptic for every credit on the way up, leaving the last to the success haptic', () => {
    expect(welcomeCountUpTicks(25)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(welcomeCountUpTicks(1)).toEqual([]);
  });

  it('runs fast off the mark and slows into the landing', () => {
    expect(welcomeFillProgress(0)).toBe(0);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS / 4)).toBeCloseTo(0.4375, 3);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS / 2)).toBeCloseTo(0.75, 3);
    // The last credit lands within a quarter of a second of the one before.
    expect(Math.floor(25 * welcomeFillProgress(WELCOME_COUNT_UP_MS - 260))).toBe(24);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS)).toBe(1);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS * 2)).toBe(1);
    expect(welcomeFillProgress(-10)).toBe(0);
  });

  it('never adds more than one credit a frame, so every credit gets its tick', () => {
    const amount = 25;
    let previous = 0;
    for (let elapsed = 0; elapsed <= WELCOME_COUNT_UP_MS; elapsed += 16) {
      const value = Math.floor(amount * welcomeFillProgress(elapsed));
      expect(value - previous).toBeLessThanOrEqual(1);
      previous = value;
    }
  });
});
