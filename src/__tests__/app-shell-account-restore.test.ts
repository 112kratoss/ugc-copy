import { readFileSync } from 'node:fs';
import path from 'node:path';

import postcss, { type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APP_SHELL_AUTH_USER_ATTRIBUTE,
  APP_SHELL_CREDITS_DIGITS_STORAGE_KEY,
  APP_SHELL_CREDITS_ZEROS_PROPERTY,
  buildAppShellAccountRestore,
  countCreditDigits,
  rememberAppShellCreditDigits,
} from '@/lib/app-shell-account-restore';
import {
  getSupabaseAuthCookiePrefix,
  hasSupabaseAuthCookie,
  readSupabaseAuthCookieUserId,
} from '@/lib/supabase-auth-cookie';

// A signed-in refresh drew the top bar's account three ways ("Sign in", then "Credits" and the
// avatar, then "617 credits"), and each moved the bell, Create and the search field sideways
// (owner's screen recording, 2026-11-14). The root layout now marks a browser that holds a session
// cookie before the page draws, with the width of the last balance, and the stylesheet shows the
// slot's signed-in shape from the first paint. The slot itself is deferred-app-shell-islands' and
// app-shell-account's; the bar in a browser is the archive's probe (web-refresh-layout-shift).

const ROOT = process.cwd();
const PROJECT_URL = 'https://example.supabase.co';
const PREFIX = getSupabaseAuthCookiePrefix(PROJECT_URL)!;
const root = document.documentElement;

function restore(prefix: string | null = PREFIX) {
  new Function(buildAppShellAccountRestore(prefix))();
}

function setCookies(names: string[]) {
  for (const name of names) document.cookie = `${name}=x; path=/`;
}

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

afterEach(() => {
  clearCookies();
  delete root.dataset.authHint;
  root.removeAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE);
  root.style.removeProperty(APP_SHELL_CREDITS_ZEROS_PROPERTY);
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A session as @supabase/ssr writes it: `base64-` + base64url(JSON). */
function sessionCookie(session: unknown) {
  return `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
}

describe('the account slot marked before the page draws', () => {
  it.each([
    [[PREFIX]],
    [[`${PREFIX}.0`, `${PREFIX}.1`]],
    [[`${PREFIX}-code-verifier`]],
    [[`sb-another-auth-token`]],
    [['e2e-auth', 'theme']],
    [[]],
  ])('reads the session cookie as hasSupabaseAuthCookie does: %j', (names) => {
    setCookies(names);
    restore();
    const expected = hasSupabaseAuthCookie(document.cookie, PROJECT_URL);
    expect(root.dataset.authHint).toBe(expected ? 'signed-in' : undefined);
  });

  it('marks nothing without a project to name the cookie', () => {
    setCookies([PREFIX]);
    restore(null);
    expect(root.dataset.authHint).toBeUndefined();
    expect(root.getAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE)).toBeNull();
  });

  // Report user and Block user are drawn by the server for a browser with a session cookie, and
  // must never show on the post of the account the cookie names (review of #833): the root element
  // names that account before the post page draws.
  const whole = sessionCookie({ access_token: 'a.b.c', user: { id: 'user-a', user_metadata: { name: 'Zoë Ångström' } } });
  it.each([
    ['the whole cookie', [[PREFIX, whole]]],
    ['its chunks, out of order', [[`${PREFIX}.1`, whole.slice(40)], [`${PREFIX}.0`, whole.slice(0, 40)]]],
    ['a cookie of JSON', [[PREFIX, encodeURIComponent(JSON.stringify({ user: { id: 'user-b' } }))]]],
    ['a session with no user', [[PREFIX, sessionCookie({ access_token: 'a.b.c' })]]],
    ['a cookie that is not a session', [[PREFIX, 'base64-%%%']]],
    ['another project\'s cookie', [['sb-another-auth-token', whole]]],
    ['no cookie', []],
  ])('names the account as readSupabaseAuthCookieUserId does: %s', (_case, cookies) => {
    for (const [name, value] of cookies) document.cookie = `${name}=${value}; path=/`;
    restore();
    expect(root.getAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE))
      .toBe(readSupabaseAuthCookieUserId(document.cookie, PROJECT_URL));
  });

  it('names the account of a whole session cookie, and of one in chunks', () => {
    document.cookie = `${PREFIX}=${whole}; path=/`;
    restore();
    expect(root.getAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE)).toBe('user-a');
    clearCookies();
    root.removeAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE);

    document.cookie = `${PREFIX}.0=${whole.slice(0, 40)}; path=/`;
    document.cookie = `${PREFIX}.1=${whole.slice(40)}; path=/`;
    restore();
    expect(root.getAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE)).toBe('user-a');
  });

  it('leaves no variable of its own on the page', () => {
    document.cookie = `${PREFIX}=${whole}; path=/`;
    const before = new Set(Object.keys(window));
    // As the page runs it: a classic script's top-level names would be the window's.
    const script = document.createElement('script');
    script.textContent = buildAppShellAccountRestore(PREFIX);
    document.head.appendChild(script);
    script.remove();
    // It ran.
    expect(root.getAttribute(APP_SHELL_AUTH_USER_ATTRIBUTE)).toBe('user-a');
    expect(Object.keys(window).filter((name) => !before.has(name) && ['q', 'w', 'k', 'r', 't', 'b', 'u'].includes(name)))
      .toEqual([]);
  });

  it('gives the placeholder the width of the last balance this browser showed, as that many zeros', () => {
    window.localStorage.setItem(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY, '4');
    restore();
    expect(root.style.getPropertyValue(APP_SHELL_CREDITS_ZEROS_PROPERTY)).toBe('"0000"');
  });

  it.each(['0', '10', '2.5', 'four', ''])('ignores a kept width of %j', (kept) => {
    window.localStorage.setItem(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY, kept);
    restore();
    expect(root.style.getPropertyValue(APP_SHELL_CREDITS_ZEROS_PROPERTY)).toBe('');
  });

  it('still marks the cookie where storage is refused', () => {
    setCookies([PREFIX]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => restore()).not.toThrow();
    expect(root.dataset.authHint).toBe('signed-in');
  });

  it('keeps the digits of each balance drawn, up to nine', () => {
    expect([0, 7, 25, 617, 1295, -4, 12.9, 10 ** 12].map(countCreditDigits)).toEqual([1, 1, 2, 3, 4, 1, 2, 9]);
    rememberAppShellCreditDigits(1295);
    expect(window.localStorage.getItem(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY)).toBe('4');
  });

  it('runs in the root layout ahead of the page', () => {
    const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
    const script = layout.indexOf('<script dangerouslySetInnerHTML={{ __html: appShellAccountRestore }} />');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(layout.indexOf('href="#main-content"'));
  });

  it('shows one shape of the slot by the mark, and sizes the placeholder from the kept width', () => {
    const sheet = postcss.parse(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
    const rules: Record<string, Record<string, string>> = {};
    sheet.walkRules((rule: Rule) => {
      if (rule.parent?.type !== 'root') return;
      for (const selector of rule.selectors) {
        if (!selector.includes('app-shell-when-signed') && !selector.includes('app-shell-credits-pending-digits')) continue;
        rule.walkDecls((declaration) => {
          rules[selector] = { ...rules[selector], [declaration.prop]: declaration.value };
        });
      }
    });
    expect(rules).toEqual({
      "html[data-auth-hint='signed-in'] .app-shell-when-signed-out": { display: 'none' },
      "html:not([data-auth-hint='signed-in']) .app-shell-when-signed-in": { display: 'none' },
      // Drawn as that many zeros in the balance's tabular figures: a box of 1ch a digit (a plain
      // "0") was 0.33px a digit wider, and the controls beside it moved as the balance came.
      '.app-shell-credits-pending-digits::before': {
        content: `var(${APP_SHELL_CREDITS_ZEROS_PROPERTY}, "000")`,
      },
    });
  });
});
