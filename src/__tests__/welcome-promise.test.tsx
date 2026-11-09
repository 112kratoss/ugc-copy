import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, renderHook } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as welcomePromise from '@/lib/welcome-promise';
import {
  endWelcomePromise,
  resetWelcomePromiseForTests,
  useWelcomePromise,
  WELCOME_PROMISE_STORAGE_KEY,
} from '@/lib/welcome-promise';
import { LEGACY_WELCOME_PROMISE_STORAGE_KEY, WELCOME_PROMISE_RESTORE } from '@/lib/welcome-promise-restore';

// The owner, 2026-11-09: "i signed up and claim the free credits and then i logged out. then it
// should not be saying the 25 free creds right !" The web's half of the app's rule (#738). Then,
// shown that an account made before the program kept the promise ("Still says 25"), the owner
// chose "Any sign-in ends it": once an account has signed in on this browser, the screens a
// signed-out visitor sees stop promising the welcome credits, whatever that account was told.

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

describe('the record', () => {
  // Review of #746: a tab still running #744's code after the deploy removes #744's key for an
  // account still owed its credits, so this rule keeps a key of its own, which no older code knows.
  it('is kept under a key of its own, and #744’s record counts as a sign-in here too', () => {
    expect(WELCOME_PROMISE_STORAGE_KEY).toBe('magicbooklet.welcome-promise.signed-in.v2');
    expect(LEGACY_WELCOME_PROMISE_STORAGE_KEY).toBe('magicbooklet.welcome-promise.spent.v1');

    window.localStorage.setItem(LEGACY_WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T09:00:00.000Z');
    expect(renderHook(() => useWelcomePromise()).result.current).toBe(false);
  });

  it('is written under its own key only', () => {
    endWelcomePromise('2026-11-09T10:00:00.000Z');
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T10:00:00.000Z');
    expect(window.localStorage.getItem(LEGACY_WELCOME_PROMISE_STORAGE_KEY)).toBeNull();
  });

  it('outlives a tab still running #744’s code, which removes only its own key', () => {
    window.localStorage.setItem(LEGACY_WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T09:00:00.000Z');
    const { result } = renderHook(() => useWelcomePromise());
    act(() => endWelcomePromise());

    // The old tab reads an account still owed its credits and takes its record back.
    act(() => {
      window.localStorage.removeItem(LEGACY_WELCOME_PROMISE_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: LEGACY_WELCOME_PROMISE_STORAGE_KEY }));
    });
    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');
  });

  it('is only ever ended: no welcome answer brings the promise back any more', () => {
    expect(Object.keys(welcomePromise).sort()).toEqual([
      'WELCOME_PROMISE_STORAGE_KEY',
      'endWelcomePromise',
      'resetWelcomePromiseForTests',
      'useWelcomePromise',
    ]);
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

  it('ends once an account has signed in here, kept across a sign-out and a new page', () => {
    const { result } = renderHook(() => useWelcomePromise());

    act(() => endWelcomePromise('2026-11-09T10:00:00.000Z'));

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T10:00:00.000Z');
    expect(rootMark()).toBe('spent');

    // A new page of this browser, signed out: only the record is left.
    resetWelcomePromiseForTests();
    delete document.documentElement.dataset.welcomePromise;
    expect(renderHook(() => useWelcomePromise()).result.current).toBe(false);
  });

  it('keeps the first sign-in’s record, so each page an account opens writes nothing', () => {
    endWelcomePromise('2026-11-09T10:00:00.000Z');
    const write = vi.spyOn(Storage.prototype, 'setItem');

    endWelcomePromise('2026-11-09T11:00:00.000Z');

    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T10:00:00.000Z');
  });

  it('holds it on this page where storage refuses the write, and writes it at the next sign-in seen', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useWelcomePromise());

    act(() => endWelcomePromise());

    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');

    write.mockRestore();
    act(() => endWelcomePromise('2026-11-09T12:00:00.000Z'));
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).toBe('2026-11-09T12:00:00.000Z');
    expect(result.current).toBe(false);
  });

  // Review of #746: what this page saw stays, whatever another tab's storage does.
  it('keeps an end this page saw where storage refused it, even when another tab clears storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useWelcomePromise());
    act(() => endWelcomePromise());

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');
  });

  it('follows another tab: a sign-in there ends it here, and a record cleared there brings it back', () => {
    const { result } = renderHook(() => useWelcomePromise());
    expect(result.current).toBe(true);

    act(() => {
      window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T11:00:00.000Z');
      window.dispatchEvent(new StorageEvent('storage', { key: WELCOME_PROMISE_STORAGE_KEY }));
    });
    expect(result.current).toBe(false);
    expect(rootMark()).toBe('spent');

    // The site's storage cleared from the browser's settings, in another tab.
    act(() => {
      window.localStorage.removeItem(WELCOME_PROMISE_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current).toBe(true);
    expect(rootMark()).toBeUndefined();
  });

  // Review of #744 (sweep): a tab with nothing listening missed another tab's record.
  it('reads another tab’s record even where nothing on this page was listening', () => {
    // Another tab's account signs in, and this one hears no storage event (nothing subscribed yet).
    window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T00:00:00.000Z');
    const { result } = renderHook(() => useWelcomePromise());
    expect(result.current).toBe(false);
    // The root's mark catches up as the first consumer subscribes.
    expect(rootMark()).toBe('spent');
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

  it('marks #744’s record too', () => {
    window.localStorage.setItem(LEGACY_WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T09:00:00.000Z');
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
