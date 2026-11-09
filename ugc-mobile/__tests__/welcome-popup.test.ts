import { beforeEach, describe, expect, it } from 'vitest';

import {
  dismissWelcomePopupThisRun,
  isWelcomePopupPlace,
  markWelcomeReturn,
  resetWelcomePopupThisRun,
  shouldShowWelcomePopup,
  subscribeToWelcomeReturn,
  wasWelcomePopupDismissedThisRun,
  WELCOME_COUNT_UP_MS,
  welcomeCountUpTicks,
  welcomeFillProgress,
  welcomeReturnPath,
  welcomeRoutePath,
} from '../lib/welcome-popup';
import * as shared from '../lib/welcome-popup-policy/welcome-popup-policy';

describe('when the welcome-credits popup shows over Home (owner 11-09)', () => {
  const eligible = { status: 'eligible' as const, identityComplete: true };
  const base = { signedIn: true, welcome: eligible, offeredHere: true, dismissed: false };

  beforeEach(() => resetWelcomePopupThisRun());

  it('offers claimable credits to a named, signed-in account on Home', () => {
    expect(shouldShowWelcomePopup(base)).toBe(true);
  });

  it('stays away otherwise', () => {
    expect(shouldShowWelcomePopup({ ...base, signedIn: false })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, offeredHere: false })).toBe(false);
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

describe('the rules shared with the web', () => {
  it('are the shared module itself, so the web’s popup offers and fills by the same rules', () => {
    expect(shouldShowWelcomePopup).toBe(shared.shouldShowWelcomePopup);
    expect(welcomeFillProgress).toBe(shared.welcomeFillProgress);
    expect(welcomeCountUpTicks).toBe(shared.welcomeCountUpTicks);
    expect(WELCOME_COUNT_UP_MS).toBe(shared.WELCOME_COUNT_UP_MS);
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

// A sign-up started from a creator's Generate went back to the creator with no
// popup and 0 credits, and the creator offered a top-up (found reading the code
// on 2026-11-09, seen on the iPhone simulator the same day).
describe('the screen a sign-up returned to (owner 11-09: the popup shows there too)', () => {
  beforeEach(() => resetWelcomePopupThisRun());

  it('reads a route as expo-router names the screen in front: no groups, no query, no trailing slash', () => {
    expect(welcomeRoutePath('/(tabs)/creator?tool=image&guided=1')).toBe('/creator');
    expect(welcomeRoutePath('/(tabs)')).toBe('/');
    expect(welcomeRoutePath('/(tabs)/index')).toBe('/');
    expect(welcomeRoutePath('/create/video?remix=abc#top')).toBe('/create/video');
    expect(welcomeRoutePath('/post/123/')).toBe('/post/123');
    expect(welcomeRoutePath('/')).toBe('/');
  });

  it('offers it on Home, and on the screen a finished sign-up went back to', () => {
    expect(isWelcomePopupPlace({ pathname: '/', returnedTo: null })).toBe(true);
    expect(isWelcomePopupPlace({ pathname: '/creator', returnedTo: null })).toBe(false);

    markWelcomeReturn('/(tabs)/creator?tool=image');
    expect(welcomeReturnPath()).toBe('/creator');
    expect(isWelcomePopupPlace({ pathname: '/creator', returnedTo: welcomeReturnPath() })).toBe(true);
    expect(isWelcomePopupPlace({ pathname: '/create/image', returnedTo: welcomeReturnPath() })).toBe(false);
    expect(isWelcomePopupPlace({ pathname: '/onboarding', returnedTo: welcomeReturnPath() })).toBe(false);
  });

  it('tells whoever listens, and is forgotten at the next app start', () => {
    const heard: Array<string | null> = [];
    const stop = subscribeToWelcomeReturn(() => heard.push(welcomeReturnPath()));
    markWelcomeReturn('/create/motion');
    stop();
    markWelcomeReturn('/create/image');
    expect(heard).toEqual(['/create/motion']);
    resetWelcomePopupThisRun();
    expect(welcomeReturnPath()).toBeNull();
  });
});
