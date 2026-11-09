import { useSyncExternalStore } from 'react';

import type { WelcomeCreditStatus } from '@/lib/onboarding';
import { WELCOME_PROMISE_SPENT, WELCOME_PROMISE_STORAGE_KEY } from '@/lib/welcome-promise-restore';

export { WELCOME_PROMISE_STORAGE_KEY };

/**
 * Whether what a signed-out visitor sees on the web may promise the welcome credits in this
 * browser: the top bar's "Sign in · 25 free credits", the sign-in page's "Join free and get 25
 * credits to start" and Home's "Free to try" (owner, 2026-11-09: "i signed up and claim the free
 * credits and then i logged out. then it should not be saying the 25 free creds right !"). The
 * web's half of the app's rule (#738, `ugc-mobile/lib/welcome-promise.ts`), under the same key.
 *
 * The server cannot tell who a signed-out visitor is, so the browser remembers what the last
 * account signed in here was told (localStorage, kept across sign-out). Once that account's
 * credits are claimed, by it or by another account of the same person, the promise stops; an
 * account that still has them coming brings it back, so a new person on a shared computer sees it
 * after their own sign-up. A browser with no record keeps the promise, and so does one whose
 * storage cannot be read: that is what every visitor saw before this record existed.
 *
 * The root layout marks a spent record on the page before it draws (`welcome-promise-restore.ts`),
 * so `globals.css` hides the promise from the first paint; `useWelcomePromise` gives the same
 * answer to React once the page's script runs.
 */

/**
 * What an account's welcome answer says about the promise in this browser: `true` while its
 * credits are still to come, `false` once they are gone for this person, `null` when the answer
 * says nothing about it. The app's mapping, status for status.
 */
export function welcomePromiseAfterAnswer(status: WelcomeCreditStatus): boolean | null {
  switch (status) {
    case 'eligible':
    // Waiting only on the creator name.
    case 'not_eligible':
      return true;
    case 'claimed':
    case 'already_claimed':
    // The same person already had them on another account.
    case 'identity_already_claimed':
      return false;
    // The server answers this to an account made before the program, and to one holding 25
    // credits while the program is off: neither says this person had the welcome credits.
    case 'legacy_ineligible':
    // A guest's answer, or the program off for now.
    case 'requires_account':
    case 'unavailable':
      return null;
    default:
      return null;
  }
}

// This tab's latest answer. It holds where storage refused the write, until another tab's
// answer lands in storage, which is newer.
let answered: boolean | null = null;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY) === null;
  } catch {
    return true;
  }
}

function snapshot(): boolean {
  return answered ?? readStored();
}

// The server knows nothing of this browser: it draws the promise, and the root's mark hides it.
const serverSnapshot = () => true;

/** The root element's mark, which `globals.css` reads, kept with the answer. */
function markRoot(promise: boolean) {
  const root = document.documentElement;
  if (promise) delete root.dataset.welcomePromise;
  else root.dataset.welcomePromise = WELCOME_PROMISE_SPENT;
}

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Teaches this browser what the account signed in now was told about its welcome credits. Fed
 * only from that account's own welcome answer, never from a request that may have outlived it.
 */
export function recordWelcomeAnswer(status: WelcomeCreditStatus, now: string = new Date().toISOString()): void {
  if (typeof window === 'undefined') return;
  const next = welcomePromiseAfterAnswer(status);
  if (next === null) return;
  answered = next;
  try {
    if (next) window.localStorage.removeItem(WELCOME_PROMISE_STORAGE_KEY);
    else window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, now);
  } catch {
    // Storage refused: this tab keeps the answer, and the next answer is written again.
  }
  markRoot(next);
  notify();
}

// Another tab's sign-in or claim changes what this one may promise.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== WELCOME_PROMISE_STORAGE_KEY) return;
  answered = null;
  markRoot(readStored());
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
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
  answered = null;
  notify();
}
