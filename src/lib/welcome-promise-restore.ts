/**
 * The half of the welcome promise (`src/lib/welcome-promise.ts`) that the root layout, a server
 * component, draws: the key a browser keeps it under, and the inline script that marks it on the
 * root element before the page draws, so a browser whose account has had its welcome credits
 * never shows their promise, not even until the page's script runs. Free of React, as a server
 * component's import must be of the client's hooks (as `app-shell-sidebar-restore.ts` is).
 */

/** The key a browser keeps it under: set once spent, gone while the promise stands. The app's own (#738). */
export const WELCOME_PROMISE_STORAGE_KEY = 'magicbooklet.welcome-promise.spent.v1';

/**
 * The root element's `data-welcome-promise` while the promise is spent: `globals.css` then hides
 * every `.welcome-promise-only` and shows every `.welcome-promise-spent-only`.
 */
export const WELCOME_PROMISE_SPENT = 'spent';

/** Inline in the server's HTML, ahead of the page: the record kept in this browser, on the root element. */
export const WELCOME_PROMISE_RESTORE = `try{localStorage.getItem(${JSON.stringify(WELCOME_PROMISE_STORAGE_KEY)})!==null&&(document.documentElement.dataset.welcomePromise=${JSON.stringify(WELCOME_PROMISE_SPENT)})}catch(e){}`;
