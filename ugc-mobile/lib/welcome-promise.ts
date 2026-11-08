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
 * stops; an account that still has them waiting brings it back, so a new person
 * on a shared phone sees the promise again after their own sign-up. A phone
 * that never had an account keeps the promise, as before.
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
    // An account from before the program: this person is not owed them.
    case 'legacy_ineligible':
      return false;
    // A guest's answer, or the program off for now.
    case 'requires_account':
    case 'unavailable':
      return null;
    default:
      return null;
  }
}

// null until the stored answer has been read.
let promise: boolean | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (promise === next) return;
  promise = next;
  for (const listener of listeners) listener();
}

/**
 * Reads the stored answer once. Called at launch from `app/_layout.tsx`, so it
 * is known before Home draws its top bar. A read that fails keeps the promise:
 * that is what every phone showed before this record existed.
 */
export function loadWelcomePromise(): Promise<void> {
  loading ??= (async () => {
    let stored = true;
    try {
      stored = (await AsyncStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)) === null;
    } catch {
      stored = true;
    }
    // An answer learned while the read was in flight is newer than the store.
    if (promise === null) publish(stored);
  })();
  return loading;
}

/** Teaches the phone an account's welcome answer, from a fetch or a claim. */
export function rememberWelcomeAnswer(status: WelcomeStatus, now = new Date().toISOString()) {
  const next = welcomePromiseAfterAnswer(status);
  if (next === null || next === promise) return;
  publish(next);
  const write = next
    ? AsyncStorage.removeItem(WELCOME_PROMISE_STORAGE_KEY)
    : AsyncStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, now);
  // At worst the next launch shows what the phone knew before this answer.
  write.catch(() => undefined);
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

/** For tests: a fresh launch. */
export function resetWelcomePromiseForTests() {
  promise = null;
  loading = null;
  listeners.clear();
}
