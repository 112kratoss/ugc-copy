import { useSyncExternalStore } from 'react';

import { WELCOME_PROMISE_SPENT, WELCOME_PROMISE_STORAGE_KEY } from '@/lib/welcome-promise-restore';

export { WELCOME_PROMISE_STORAGE_KEY };

/**
 * Whether what a signed-out visitor sees on the web may promise the welcome credits in this
 * browser: the top bar's "Sign in · 25 free credits", the sign-in page's "Join free and get 25
 * credits to start" and Home's "Free to try" (owner, 2026-11-09: "i signed up and claim the free
 * credits and then i logged out. then it should not be saying the 25 free creds right !"). The
 * web's half of the app's rule (`ugc-mobile/lib/welcome-promise.ts`), under the same key.
 *
 * Once an account has signed in on this browser, the promise ends here for good (owner,
 * 2026-11-09, shown that an account made before the program kept it: "Any sign-in ends it").
 * Whatever that account was told about its welcome credits plays no part, and a guest's session
 * is no sign-in. The server cannot tell who a signed-out visitor is, so the browser keeps the
 * record (localStorage, kept across sign-out). A browser with no record keeps the promise, and so
 * does one whose storage cannot be read: that is what every visitor saw before this record existed.
 *
 * The header ends it for every account it verifies (`AppShellAccount.tsx`), on every page with
 * the top bar; a welcome answer ends it too (`welcome-credits-requests.ts`), for the name step,
 * which has none. The root layout marks a kept record on the page before it draws
 * (`welcome-promise-restore.ts`), so `globals.css` hides the promise from the first paint;
 * `useWelcomePromise` gives the same answer to React once the page's script runs.
 */

// Ended on this page where storage refused the write; a written record is read back from storage,
// so a tab with nothing listening for another tab's changes still reads the newest (review of #744).
let endedHere = false;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY) === null;
  } catch {
    return true;
  }
}

function snapshot(): boolean {
  return !endedHere && readStored();
}

// The server knows nothing of this browser: it draws the promise, and the root's mark hides it.
const serverSnapshot = () => true;

/** The root element's mark, which `globals.css` reads, kept with the record. */
function markRoot(promise: boolean) {
  const root = document.documentElement;
  if (promise) delete root.dataset.welcomePromise;
  else root.dataset.welcomePromise = WELCOME_PROMISE_SPENT;
}

function notify() {
  for (const listener of listeners) listener();
}

/**
 * An account has signed in on this browser: the welcome credits are not promised here again.
 * The first sign-in's record is kept, so the pages an account opens afterwards write nothing.
 */
export function endWelcomePromise(now: string = new Date().toISOString()): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY) === null) {
      window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, now);
    }
    endedHere = false;
  } catch {
    // Storage refused: this page keeps it, and the next sign-in seen here writes it again.
    endedHere = true;
  }
  markRoot(false);
  notify();
}

// Another tab's sign-in, or the site's storage cleared there, changes what this one may promise.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== WELCOME_PROMISE_STORAGE_KEY) return;
  endedHere = false;
  markRoot(readStored());
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('storage', onStorage);
    // Nothing listened while another tab may have changed the record: the root's mark catches up.
    markRoot(snapshot());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Whether a signed-out visitor in this browser may be promised the welcome credits. */
export function useWelcomePromise(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** For tests: a fresh page. Components still drawn read the promise again. */
export function resetWelcomePromiseForTests() {
  endedHere = false;
  notify();
}
