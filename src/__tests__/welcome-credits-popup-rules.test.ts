import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CREATOR_WELCOME_PARAM } from '@/lib/auth-onboarding';
import {
  isWelcomeAnswerSettled,
  isWelcomePopupOfferedAt,
  isWelcomeSettledHere,
  nextWelcomeFill,
  readWelcomeReturn,
  rememberWelcomePopupClosed,
  rememberWelcomeSettled,
  resetWelcomePopupSession,
  WELCOME_POPUP_CLOSED_COOKIE,
  WELCOME_RETURN_PARAM,
  wasWelcomePopupClosedThisSession,
  welcomeEntrySpring,
} from '@/lib/welcome-credits-popup';

import {
  shouldShowWelcomePopup,
  WELCOME_COUNT_UP_MS,
  welcomeCountUpTicks,
  welcomeFillProgress,
} from '../../ugc-mobile/lib/welcome-popup-policy/welcome-popup-policy';

const USER = '9a7f1c2e-0000-4000-8000-000000000001';
const OTHER = '9a7f1c2e-0000-4000-8000-000000000002';

describe('the shared rules, read by the web (ugc-mobile/lib/welcome-popup-policy)', () => {
  const eligible = { status: 'eligible', identityComplete: true };
  const base = { signedIn: true, welcome: eligible, offeredHere: true, dismissed: false };

  it('offers claimable credits to a named, signed-in account on a page that offers them', () => {
    expect(shouldShowWelcomePopup(base)).toBe(true);
  });

  it('stays away from a visitor, another page, a close, an unnamed account and every other answer', () => {
    expect(shouldShowWelcomePopup({ ...base, signedIn: false })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, offeredHere: false })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, welcome: null })).toBe(false);
    expect(shouldShowWelcomePopup({ ...base, welcome: { ...eligible, identityComplete: false } })).toBe(false);
    for (const status of ['claimed', 'already_claimed', 'identity_already_claimed', 'legacy_ineligible', 'unavailable', 'not_eligible', 'requires_account']) {
      expect(shouldShowWelcomePopup({ ...base, welcome: { ...eligible, status } })).toBe(false);
    }
  });

  it('fills on the app’s curve: fast off the mark, landing at 1.3 s', () => {
    expect(WELCOME_COUNT_UP_MS).toBe(1300);
    expect(welcomeFillProgress(0)).toBe(0);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS / 2)).toBeCloseTo(0.75, 3);
    expect(welcomeFillProgress(WELCOME_COUNT_UP_MS)).toBe(1);
    expect(welcomeCountUpTicks(25)).toHaveLength(24);
  });
});

describe('where the web offers it (owner 11-09: Home, the creators, the page a sign-up returned to)', () => {
  it('is offered on Home and on every creator', () => {
    for (const path of ['/', '/home', '/create', '/create-image', '/create-video', '/create-motion']) {
      expect(isWelcomePopupOfferedAt(path, null), path).toBe(true);
    }
  });

  it('is offered on any other page only when a sign-up returned to it', () => {
    expect(isWelcomePopupOfferedAt('/showcase', null)).toBe(false);
    expect(isWelcomePopupOfferedAt('/showcase', '/showcase')).toBe(true);
    expect(isWelcomePopupOfferedAt('/creations', '/showcase')).toBe(false);
  });

  it('never covers sign-in, the name step, the checkout or the operator console, whatever the address says', () => {
    for (const path of ['/login', '/auth/continue', '/onboarding', '/pricing', '/pricing/checkout', '/admin', '/admin/users', '/welcome-reward']) {
      expect(isWelcomePopupOfferedAt(path, path), path).toBe(false);
    }
  });
});

describe('the flags a return from sign-up puts on the address', () => {
  it('uses the creators’ own flag name', () => {
    expect(WELCOME_RETURN_PARAM).toBe(CREATOR_WELCOME_PARAM);
  });

  it('reads the welcome flag and the invite’s outcome once, and gives the address back without them', () => {
    expect(readWelcomeReturn('/showcase', '?welcome=1&referral=applied&chip=new')).toEqual({ referral: 'applied', search: '?chip=new' });
    expect(readWelcomeReturn('/', '?welcome=1')).toEqual({ referral: null, search: '' });
  });

  it('drops an invite outcome that is not one, and reads nothing without the flag', () => {
    expect(readWelcomeReturn('/', '?welcome=1&referral=%3Cscript%3E')).toEqual({ referral: null, search: '' });
    expect(readWelcomeReturn('/', '?referral=applied')).toBeNull();
    expect(readWelcomeReturn('/', '?welcome=0')).toBeNull();
  });

  it('leaves the creators’ flags to their welcome card, and a page it never covers as it is', () => {
    expect(readWelcomeReturn('/create-video', '?welcome=1&handover=nonce-1234')).toBeNull();
    expect(readWelcomeReturn('/pricing', '?welcome=1')).toBeNull();
    expect(readWelcomeReturn('/onboarding', '?welcome=1')).toBeNull();
  });
});

describe('one frame of the fill', () => {
  it('follows the shared curve and lands on the amount', () => {
    expect(nextWelcomeFill({ elapsed: 0, amount: 25, shown: 0 })).toEqual({ fill: 0, count: 0, done: false });
    expect(nextWelcomeFill({ elapsed: WELCOME_COUNT_UP_MS, amount: 25, shown: 24 })).toEqual({ fill: 1, count: 25, done: true });
  });

  it('never moves the figure more than one credit a frame, however late the frame', () => {
    // A frame a whole second in (a busy tab): the curve says 23, the figure says 1.
    expect(nextWelcomeFill({ elapsed: 1000, amount: 25, shown: 0 })).toMatchObject({ count: 1, done: false });
    // The curve has run out: the figure keeps counting, one a frame, until it lands.
    expect(nextWelcomeFill({ elapsed: 5000, amount: 25, shown: 20 })).toEqual({ fill: 1, count: 21, done: false });
  });

  it('shows every credit at sixty frames a second', () => {
    let shown = 0;
    const seen = new Set<number>([0]);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 1000 / 60) {
      const frame = nextWelcomeFill({ elapsed, amount: 25, shown });
      expect(frame.count - shown).toBeLessThanOrEqual(1);
      shown = frame.count;
      seen.add(shown);
      if (frame.done) break;
    }
    expect(shown).toBe(25);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 26 }, (_, index) => index));
  });
});

describe('a close lasts for the browser session, per account', () => {
  beforeEach(() => resetWelcomePopupSession());
  afterEach(() => resetWelcomePopupSession());

  it('is kept in a session cookie that names the account', () => {
    expect(wasWelcomePopupClosedThisSession(USER)).toBe(false);
    rememberWelcomePopupClosed(USER);
    expect(wasWelcomePopupClosedThisSession(USER)).toBe(true);
    expect(wasWelcomePopupClosedThisSession(OTHER)).toBe(false);
    expect(document.cookie).toContain(`${WELCOME_POPUP_CLOSED_COOKIE}=${USER}`);
  });

  it('keeps every account that closed it in this browser', () => {
    rememberWelcomePopupClosed(USER);
    rememberWelcomePopupClosed(OTHER);
    expect(wasWelcomePopupClosedThisSession(USER)).toBe(true);
    expect(wasWelcomePopupClosedThisSession(OTHER)).toBe(true);
  });

  it('holds for the page where cookies are refused', () => {
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => undefined });
    try {
      rememberWelcomePopupClosed(USER);
      expect(wasWelcomePopupClosedThisSession(USER)).toBe(true);
    } finally {
      delete (document as unknown as Record<string, unknown>).cookie;
    }
  });
});

describe('an account whose credits are settled', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('is the answer that can never offer them again', () => {
    for (const status of ['claimed', 'already_claimed', 'identity_already_claimed']) expect(isWelcomeAnswerSettled(status)).toBe(true);
    for (const status of ['eligible', 'not_eligible', 'legacy_ineligible', 'unavailable', null]) expect(isWelcomeAnswerSettled(status)).toBe(false);
  });

  it('is remembered in this browser for a week, under the key Home’s card wrote', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    rememberWelcomeSettled(USER);
    expect(window.localStorage.getItem(`magicbooklet:welcome-settled:v1:${USER}`)).not.toBeNull();
    expect(isWelcomeSettledHere(USER)).toBe(true);
    expect(isWelcomeSettledHere(OTHER)).toBe(false);
    vi.setSystemTime(new Date('2026-11-16T10:00:01Z'));
    expect(isWelcomeSettledHere(USER)).toBe(false);
  });
});

describe('the card’s entrance', () => {
  it('is the app’s spring: past 1 by a few hundredths, at rest in about a third of a second', () => {
    const { durationMs, progress } = welcomeEntrySpring();
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(Math.max(...progress)).toBeGreaterThan(1.02);
    expect(Math.max(...progress)).toBeLessThan(1.06);
    expect(durationMs).toBeGreaterThan(300);
    expect(durationMs).toBeLessThan(420);
  });
});
