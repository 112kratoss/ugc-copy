/**
 * The half of the welcome promise (`src/lib/welcome-promise.ts`) that the root layout, a server
 * component, draws: the keys a browser keeps it under, and the inline script that marks it on the
 * root element before the page draws, so a browser an account has signed in on never shows
 * their promise, not even until the page's script runs. Free of React, as a server
 * component's import must be of the client's hooks (as `app-shell-sidebar-restore.ts` is).
 */

/**
 * The key a browser keeps it under: set at the first sign-in seen here, never removed. A key of
 * its own, which no older code knows: a tab still running #744's code after a deploy removed that
 * one's record for an account still owed its credits (review of #746).
 */
export const WELCOME_PROMISE_STORAGE_KEY = 'magicbooklet.welcome-promise.signed-in.v2';

/** #744's record (an account here had its welcome credits): an account signed in here too, so read as spent, never written. */
export const LEGACY_WELCOME_PROMISE_STORAGE_KEY = 'magicbooklet.welcome-promise.spent.v1';

/** Every key whose record ends the promise. */
export const WELCOME_PROMISE_STORAGE_KEYS: readonly string[] = [WELCOME_PROMISE_STORAGE_KEY, LEGACY_WELCOME_PROMISE_STORAGE_KEY];

/**
 * The root element's `data-welcome-promise` while the promise is spent: `globals.css` then hides
 * every `.welcome-promise-only` and shows every `.welcome-promise-spent-only`.
 */
export const WELCOME_PROMISE_SPENT = 'spent';

/** Inline in the server's HTML, ahead of the page: the record kept in this browser, on the root element. */
export const WELCOME_PROMISE_RESTORE = `try{${JSON.stringify(WELCOME_PROMISE_STORAGE_KEYS)}.some(function(k){return localStorage.getItem(k)!==null})&&(document.documentElement.dataset.welcomePromise=${JSON.stringify(WELCOME_PROMISE_SPENT)})}catch(e){}`;
