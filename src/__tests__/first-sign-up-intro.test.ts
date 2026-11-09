import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decideFirstSignUpIntro,
  FIRST_SIGN_UP_INTRO_COVER_SCRIPT,
  FIRST_SIGN_UP_INTRO_COVER_WAIT,
  FIRST_SIGN_UP_INTRO_STORAGE_KEY,
  liftFirstSignUpIntroCover,
  markFirstSignUpIntroSeen,
  readFirstSignUpIntroCover,
  readFirstSignUpIntroStore,
  type FirstSignUpIntroInput,
} from '@/lib/first-sign-up-intro';

// When the web plays the first sign-up intro (owner, 2026-11-09): once per
// browser, right after the first sign-up and before the creator-name step. The
// intro itself is first-sign-up-intro-gate.test.tsx's.

const firstSignUp: FirstSignUpIntroInput = { pathname: '/onboarding', stored: 'unseen', pageShown: false };

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe('decideFirstSignUpIntro', () => {
  it('plays on the name step for a browser that has never seen it', () => {
    expect(decideFirstSignUpIntro(firstSignUp)).toBe('show');
  });

  it('plays only on /onboarding: never on Home, the landing page people reach from search, or any other page', () => {
    for (const pathname of ['/', '/home', '/login', '/onboarding/x', '/profile', null]) {
      expect(decideFirstSignUpIntro({ ...firstSignUp, pathname })).toBe('skip');
    }
  });

  it('plays once per browser', () => {
    expect(decideFirstSignUpIntro({ ...firstSignUp, stored: 'seen' })).toBe('skip');
  });

  it('does not play where storage cannot be read, or it would play at every visit', () => {
    expect(decideFirstSignUpIntro({ ...firstSignUp, stored: 'unavailable' })).toBe('skip');
  });

  it('never comes in over a name step already on screen', () => {
    expect(decideFirstSignUpIntro({ ...firstSignUp, pageShown: true })).toBe('skip');
  });
});

describe('the flag in this browser', () => {
  it('reads unseen, then seen once marked', () => {
    const storage = memoryStorage();
    expect(readFirstSignUpIntroStore(storage)).toBe('unseen');
    expect(markFirstSignUpIntroSeen(storage, new Date('2026-11-09T00:00:00.000Z'))).toBe(true);
    expect(storage.values.get(FIRST_SIGN_UP_INTRO_STORAGE_KEY)).toBe('2026-11-09T00:00:00.000Z');
    expect(readFirstSignUpIntroStore(storage)).toBe('seen');
  });

  it('reads storage it cannot reach as unavailable', () => {
    expect(readFirstSignUpIntroStore(null)).toBe('unavailable');
    expect(readFirstSignUpIntroStore({ getItem: () => { throw new Error('SecurityError'); } })).toBe('unavailable');
  });

  it('reports a refused write, so the intro does not play', () => {
    expect(markFirstSignUpIntroSeen(null)).toBe(false);
    expect(markFirstSignUpIntroSeen({
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    })).toBe(false);
    // A store that takes the write and keeps nothing.
    expect(markFirstSignUpIntroSeen({ getItem: () => null, setItem: () => undefined })).toBe(false);
  });
});

describe('the cover before the first paint', () => {
  const runCover = () => new Function(FIRST_SIGN_UP_INTRO_COVER_SCRIPT)();
  const root = document.documentElement;

  afterEach(() => {
    liftFirstSignUpIntroCover(root);
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('covers the page when this browser has not seen the intro', () => {
    runCover();
    expect(root.getAttribute('data-first-sign-up-intro')).toBe('cover');
    expect(readFirstSignUpIntroCover(root)).toBe('cover');
  });

  it('leaves the page alone once the intro has been seen', () => {
    window.localStorage.setItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY, 'seen');
    runCover();
    expect(readFirstSignUpIntroCover(root)).toBe('none');
  });

  it('leaves the page alone where storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(runCover).not.toThrow();
    expect(readFirstSignUpIntroCover(root)).toBe('none');
  });

  it('lifts by itself when the page script is slow, and marks the page as shown', () => {
    vi.useFakeTimers();
    runCover();
    vi.advanceTimersByTime(FIRST_SIGN_UP_INTRO_COVER_WAIT - 1);
    expect(readFirstSignUpIntroCover(root)).toBe('cover');
    vi.advanceTimersByTime(1);
    expect(readFirstSignUpIntroCover(root)).toBe('lifted');
  });

  it('stays lifted once the page has decided, when its wait runs out later', () => {
    vi.useFakeTimers();
    runCover();
    liftFirstSignUpIntroCover(root);
    vi.advanceTimersByTime(FIRST_SIGN_UP_INTRO_COVER_WAIT);
    expect(readFirstSignUpIntroCover(root)).toBe('none');
  });
});
