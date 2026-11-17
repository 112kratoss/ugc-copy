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
 * The root element's attribute naming the account the session cookie holds, read as
 * `readSupabaseAuthCookieUserId` reads it, so a part of a page drawn ahead of time for everyone can
 * be hidden from that one account before the first paint (Report user and Block user, on the post
 * page of the account's own post: `ReportPostButton`). A hint, as `data-auth-hint` is.
 */
export const APP_SHELL_AUTH_USER_ATTRIBUTE = 'data-auth-user';

/**
 * Whether a style rule can name this account in `data-auth-user` as it stands (a UUID can). A part
 * drawn for one account only is drawn in the server's HTML for an account a rule can name, and for
 * no other.
 */
export function canStyleRuleNameAuthUser(userId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(userId);
}

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
 * of its chunks (`<name>.0`, `<name>.1`, …). The account is `readSupabaseAuthCookieUserId`'s: the
 * whole cookie or its chunks in order, `base64-` + base64url(JSON) or the JSON itself, and the
 * session's `user.id`. The id is ASCII, so the decoded bytes are parsed as they are.
 */
export function buildAppShellAccountRestore(
  cookiePrefix: string | null = getSupabaseAuthCookiePrefix()
): string {
  const prefix = JSON.stringify(cookiePrefix);
  const markSignedIn = cookiePrefix
    ? `try{var p=${prefix};document.cookie.split(";").some(function(c){var n=c.trim().split("=",1)[0];return n===p||n.indexOf(p+".")===0})&&(document.documentElement.dataset.authHint=${JSON.stringify(APP_SHELL_AUTH_HINT_SIGNED_IN)})}catch(e){}`
    : '';
  const markUser = cookiePrefix
    ? `(function(){try{var q=${prefix},w=null,k=[];document.cookie.split(";").forEach(function(c){var i=c.indexOf("=");if(i<0)return;var n=c.slice(0,i).trim(),v=c.slice(i+1).trim();if(n===q)w=v;else if(n.indexOf(q+".")===0){var x=Number(n.slice(q.length+1));x>=0&&x%1===0&&k.push([x,v])}});var r=w!==null?w:k.sort(function(a,b){return a[0]-b[0]}).map(function(e){return e[1]}).join("");if(r){var t=decodeURIComponent(r);if(t.indexOf("base64-")===0){var b=t.slice(7).replace(/-/g,"+").replace(/_/g,"/");t=atob(b+"===".slice((b.length+3)%4))}var u=JSON.parse(t);u=u&&u.user&&u.user.id;typeof u==="string"&&u&&document.documentElement.setAttribute(${JSON.stringify(APP_SHELL_AUTH_USER_ATTRIBUTE)},u)}}catch(e){}})();`
    : '';
  const restoreDigits = `try{var d=Number(localStorage.getItem(${JSON.stringify(APP_SHELL_CREDITS_DIGITS_STORAGE_KEY)}));d>=1&&d<=9&&d===Math.floor(d)&&document.documentElement.style.setProperty("--app-shell-credits-digits",String(d))}catch(e){}`;
  return markSignedIn + markUser + restoreDigits;
}
