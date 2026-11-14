/**
 * The half of the top bar's account slot that the root layout, a server component, draws: the
 * inline script that marks this browser on the root element before the page draws, so the slot's
 * first paint already has the shape it keeps. Free of React, as a server component's import must
 * be of the client's hooks (as `app-shell-sidebar-restore.ts` is).
 *
 * The account loads in the browser only (`DeferredAppShellAccount`), and the server cannot read
 * the visitor's cookies on a page it prerendered, so it draws the slot both ways: "Sign in", and a
 * placeholder the size of the balance and the avatar. The mark picks one. Without it a signed-in
 * refresh drew "Sign in", then "Credits" and the avatar, then "617 credits", and each change moved
 * the bell, Create and the search field sideways (owner's screen recording, 2026-11-14).
 */
import { getSupabaseAuthCookiePrefix } from '@/lib/supabase-auth-cookie';

/**
 * The root element's `data-auth-hint` while this browser holds a Supabase session cookie. A hint
 * for the first paint only, as `hasSupabaseAuthCookie` is: the account still verifies the session,
 * and the slot draws "Sign in" if it does not hold.
 */
export const APP_SHELL_AUTH_HINT_SIGNED_IN = 'signed-in';

/**
 * Where the browser keeps how many digits the last balance it showed had, so the placeholder is
 * as wide as the balance that replaces it (`--app-shell-credits-digits` in globals.css).
 */
export const APP_SHELL_CREDITS_DIGITS_STORAGE_KEY = 'magicbooklet.app-shell.credits-digits.v1';

/** The digits a balance is drawn with: a negative balance never shows, and never more than nine. */
export function countCreditDigits(credits: number): number {
  return Math.min(9, String(Math.max(0, Math.trunc(credits))).length);
}

/** Kept by the account once a balance is drawn, for the next page's placeholder. */
export function rememberAppShellCreditDigits(credits: number): void {
  try {
    window.localStorage.setItem(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY, String(countCreditDigits(credits)));
  } catch {
    // Storage refused (a private window, a full disk): the placeholder keeps its default width.
  }
}

/**
 * Inline in the server's HTML, ahead of the shell. The cookie test is `hasSupabaseAuthCookie`'s,
 * written out for a page whose own code has not loaded yet: a cookie named for the project, or one
 * of its chunks (`<name>.0`, `<name>.1`, …).
 */
export function buildAppShellAccountRestore(
  cookiePrefix: string | null = getSupabaseAuthCookiePrefix()
): string {
  const markSignedIn = cookiePrefix
    ? `try{var p=${JSON.stringify(cookiePrefix)};document.cookie.split(";").some(function(c){var n=c.trim().split("=",1)[0];return n===p||n.indexOf(p+".")===0})&&(document.documentElement.dataset.authHint=${JSON.stringify(APP_SHELL_AUTH_HINT_SIGNED_IN)})}catch(e){}`
    : '';
  const restoreDigits = `try{var d=Number(localStorage.getItem(${JSON.stringify(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY)}));d>=1&&d<=9&&d===Math.floor(d)&&document.documentElement.style.setProperty("--app-shell-credits-digits",String(d))}catch(e){}`;
  return markSignedIn + restoreDigits;
}
