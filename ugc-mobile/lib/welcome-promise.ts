import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import type { WelcomeCreditResponse } from './types';

/**
 * Whether the screens a signed-out visitor sees may promise the welcome credits
 * on this phone: Home's "Sign in · 25 free credits", the sign-in page's "Join
 * free and get 25 credits" and the shelf's "Free to try" (owner, 2026-11-09: "i
 * signed up and claim the free credits and then i logged out. then it should
 * not be saying the 25 free creds").
 *
 * The server cannot tell who a signed-out visitor is, so the phone remembers
 * what the last account signed in here was told. Once that account's credits
 * are claimed (by it, or by another account of the same person), the promise
 * stops; an account that still has them coming brings it back, so a new person
 * on a shared phone sees the promise again after their own sign-up. A phone
 * that never had an account keeps the promise, as before. So does a phone
 * whose account signed out before this record existed, until an account signs
 * in on it again: nothing the phone kept says what that account was told.
 */
export const WELCOME_PROMISE_STORAGE_KEY = 'magicbooklet.welcome-promise.spent.v1';

type WelcomeStatus = WelcomeCreditResponse['status'];

/**
 * What an account's welcome answer says about the promise on this phone: `true`
 * when its credits are still to come, `false` when they are gone for this
 * person, `null` when the answer says nothing about it.
 */
export function welcomePromiseAfterAnswer(status: WelcomeStatus): boolean | null {
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
    // The server's `loadWelcomeCreditStatus` answers this to an account made
    // before the program and to one holding 25 credits while the program is
    // off: neither says this person had the welcome credits, and the second may
    // still be owed them when the program comes back.
    case 'legacy_ineligible':
    // A guest's answer, or the program off for now.
    case 'requires_account':
    case 'unavailable':
      return null;
    default:
      return null;
  }
}

// What screens draw: null until the stored answer has been read.
let promise: boolean | null = null;
// What the store is known to hold (true = no record), learned only from a read
// or a write that succeeded: a failed one is tried again with the next answer.
let stored: boolean | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (promise === next) return;
  promise = next;
  for (const listener of listeners) listener();
}

function persist(next: boolean, now: string) {
  let write: Promise<void>;
  try {
    write = next
      ? AsyncStorage.removeItem(WELCOME_PROMISE_STORAGE_KEY)
      : AsyncStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, now);
  } catch {
    return;
  }
  write.then(
    () => {
      stored = next;
    },
    () => undefined,
  );
}

/**
 * Reads the stored answer once. Called at launch from `app/_layout.tsx`, so it
 * is known before Home draws its top bar. A read that fails keeps the promise:
 * that is what every phone showed before this record existed.
 */
export function loadWelcomePromise(): Promise<void> {
  loading ??= (async () => {
    let read: boolean | null = null;
    try {
      read = (await AsyncStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)) === null;
    } catch {
      read = null;
    }
    if (read !== null && stored === null) stored = read;
    // An answer learned while the read was in flight is newer than the store.
    if (promise === null) publish(read ?? true);
  })();
  return loading;
}

/**
 * Teaches the phone what the account signed in now was told. Fed only from
 * that account's own answer (`useWelcomeCreditsQuery`), never from a request
 * that may have outlived its account.
 */
export function rememberWelcomeAnswer(status: WelcomeStatus, now = new Date().toISOString()) {
  const next = welcomePromiseAfterAnswer(status);
  if (next === null) return;
  publish(next);
  if (stored !== next) persist(next, now);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Until the store is read: the promise, as on a phone new to the app. Read as
// what screens draw, so the launch read of a phone with no record redraws none.
const snapshot = () => promise ?? true;

/** Whether a signed-out visitor here may be promised the welcome credits. */
export function useWelcomePromise(): boolean {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadWelcomePromise();
  }, []);
  return value;
}

/** For tests: a fresh launch. Screens still drawn read the promise again. */
export function resetWelcomePromiseForTests() {
  promise = null;
  stored = null;
  loading = null;
  for (const listener of listeners) listener();
}
