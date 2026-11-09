import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, renderHook } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WelcomeCreditStatus } from '@/lib/onboarding';
import {
  recordWelcomeAnswer,
  resetWelcomePromiseForTests,
  useWelcomePromise,
  WELCOME_PROMISE_STORAGE_KEY,
  welcomePromiseAfterAnswer,
} from '@/lib/welcome-promise';
import { WELCOME_PROMISE_RESTORE } from '@/lib/welcome-promise-restore';

// The owner, 2026-11-09: "i signed up and claim the free credits and then i logged out. then it
// should not be saying the 25 free creds right !" The web's half of the app's rule (#738): the
// browser remembers what its last account was told, and the screens a signed-out visitor sees
// stop promising the welcome credits once that account has had them.

const ROOT = process.cwd();
const restore = () => new Function(WELCOME_PROMISE_RESTORE)();
const rootMark = () => document.documentElement.dataset.welcomePromise;

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.welcomePromise;
  resetWelcomePromiseForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.welcomePromise;
  resetWelcomePromiseForTests();
});

describe('what an account’s welcome answer says about the promise', () => {
  it('maps every status as the app does', () => {
    const cases: Array<[WelcomeCreditStatus, boolean | null]> = [
      ['eligible', true],
      ['not_eligible', true],
      ['claimed', false],
      ['already_claimed', false],
      ['identity_already_claimed', false],
      ['legacy_ineligible', null],
      ['requires_account', null],
      ['unavailable', null],
    ];
    for (const [status, promise] of cases) expect(welcomePromiseAfterAnswer(status), status).toBe(promise);
    expect(welcomePromiseAfterAnswer('something-new' as WelcomeCreditStatus)).toBeNull();
  });

  it('is kept under the app’s key', () => {
    expect(WELCOME_PROMISE_STORAGE_KEY).toBe('magicbooklet.welcome-promise.spent.v1');
  });
});

describe('the promise in this browser', () => {
  it('stands where nothing was recorded, and where storage cannot be read', () => {
    const { result, unmount } = renderHook(() => useWelcomePromise());
    expect(result.current).toBe(true);
    unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(renderHook(() => useWelcomePromise()).result.current).toBe(true);
  });

  it('stops once the account’s credits are claimed, kept across a sign-out and a new page', () => {
    const { result } = renderHook(() => useWelcomePromise());

    act(() => recordWelcomeAnswer('claimed', '2026-11-09T10:00:00.000Z'));

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T10:00:00.000Z');
    expect(rootMark()).toBe('spent');

    // A new page of this browser, signed out: only the record is left.
    resetWelcomePromiseForTests();
    delete document.documentElement.dataset.welcomePromise;
    expect(renderHook(() => useWelcomePromise()).result.current).toBe(false);
  });

  it('stops for the same person on another account, and comes back for an account still owed them', () => {
    const { result } = renderHook(() => useWelcomePromise());

    act(() => recordWelcomeAnswer('identity_already_claimed'));
    expect(result.current).toBe(false);

    act(() => recordWelcomeAnswer('not_eligible'));
    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBeNull();
    expect(rootMark()).toBeUndefined();

    act(() => recordWelcomeAnswer('already_claimed'));
    act(() => recordWelcomeAnswer('eligible'));
    expect(result.current).toBe(true);
  });

  it('is left as it is by an answer that says nothing about it', () => {
    const { result } = renderHook(() => useWelcomePromise());
    act(() => recordWelcomeAnswer('claimed'));

    for (const status of ['legacy_ineligible', 'requires_account', 'unavailable'] as const) {
      act(() => recordWelcomeAnswer(status));
      expect(result.current, status).toBe(false);
    }
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).not.toBeNull();
  });

  it('holds this page’s answer where storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useWelcomePromise());

    act(() => recordWelcomeAnswer('claimed'));

    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');
  });

  it('follows another tab’s answer, which is newer than this page’s', () => {
    const { result } = renderHook(() => useWelcomePromise());
    act(() => recordWelcomeAnswer('eligible'));
    expect(result.current).toBe(true);

    act(() => {
      window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T11:00:00.000Z');
      window.dispatchEvent(new StorageEvent('storage', { key: WELCOME_PROMISE_STORAGE_KEY }));
    });
    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');

    act(() => {
      window.localStorage.removeItem(WELCOME_PROMISE_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: WELCOME_PROMISE_STORAGE_KEY }));
    });
    expect(result.current).toBe(true);
    expect(rootMark()).toBeUndefined();
  });

  // Review of #744 (sweep): a tab with nothing listening missed another tab's answer, and kept
  // its own older one in memory.
  it('reads another tab’s newer answer even where nothing on this page was listening', () => {
    recordWelcomeAnswer('eligible');
    // Another tab claims, and this one hears no storage event (nothing subscribed yet).
    window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T00:00:00.000Z');
    const { result } = renderHook(() => useWelcomePromise());
    expect(result.current).toBe(false);
    // The root's mark catches up as the first consumer subscribes.
    expect(rootMark()).toBeDefined();
  });

  it('is drawn by the server as standing: the root’s mark hides it where it was spent', () => {
    window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T10:00:00.000Z');
    function Probe() {
      return <span>{useWelcomePromise() ? 'promise' : 'spent'}</span>;
    }
    expect(renderToString(<Probe />)).toContain('promise');
  });
});

describe('the first paint', () => {
  it('is marked on the root element by the inline script, and only where the promise was spent', () => {
    restore();
    expect(rootMark()).toBeUndefined();

    window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T10:00:00.000Z');
    restore();
    expect(rootMark()).toBe('spent');
  });

  it('leaves the page as it is where storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(restore).not.toThrow();
    expect(rootMark()).toBeUndefined();
  });

  it('runs in the root layout ahead of the page', () => {
    const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
    const script = layout.indexOf('<script dangerouslySetInnerHTML={{ __html: WELCOME_PROMISE_RESTORE }} />');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(layout.indexOf('href="#main-content"'));
  });

  it('hides each promise where the root is marked, and each line for a spent promise where it is not', () => {
    const sheet = postcss.parse(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
    const rules: Record<string, Record<string, string>> = {};
    sheet.walkRules((rule: Rule) => {
      if (rule.parent?.type !== 'root') return;
      for (const selector of rule.selectors) {
        if (!selector.includes('welcome-promise')) continue;
        rule.walkDecls((declaration) => {
          rules[selector] = { ...rules[selector], [declaration.prop]: declaration.value };
        });
      }
    });
    expect(rules).toEqual({
      "html[data-welcome-promise='spent'] .welcome-promise-only": { display: 'none' },
      "html:not([data-welcome-promise='spent']) .welcome-promise-spent-only": { display: 'none' },
    });
  });
});
