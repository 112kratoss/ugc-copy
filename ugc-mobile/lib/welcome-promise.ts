import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether the screens a signed-out visitor sees may promise the welcome credits
 * on this phone: Home's "Sign in · 25 free credits", the sign-in page's "Join
 * free and get 25 credits" and the shelf's "Free to try" (owner, 2026-11-09: "i
 * signed up and claim the free credits and then i logged out. then it should
 * not be saying the 25 free creds").
 *
 * Once an account has signed in on this phone, the promise ends here for good
 * (owner, 2026-11-09, shown that an account made before the program kept it:
 * "Any sign-in ends it"). Whatever that account was told about its welcome
 * credits plays no part, and a guest is no sign-in (`useAuth().user` is null
 * for one). The server cannot tell who a signed-out visitor is, so the phone
 * keeps the record. A phone that never had an account keeps the promise, as
 * before. So does a phone whose account signed out before this record existed,
 * until an account signs in on it again. The web's half is
 * `src/lib/welcome-promise.ts`, under the same key.
 */
export const WELCOME_PROMISE_STORAGE_KEY = 'magicbooklet.welcome-promise.spent.v1';

// What screens draw: null until the stored record has been read.
let promise: boolean | null = null;
// Whether the store is known to hold the record, learned only from a read or a
// write that succeeded: a failed one is tried again at the next sign-in.
let stored: boolean | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (promise === next) return;
  promise = next;
  for (const listener of listeners) listener();
}

/**
 * Reads the stored record once. Called at launch from `app/_layout.tsx`, so it
 * is known before Home draws its top bar. A read that fails keeps the promise:
 * that is what every phone showed before this record existed.
 */
export function loadWelcomePromise(): Promise<void> {
  loading ??= (async () => {
    let held: boolean | null = null;
    try {
      held = (await AsyncStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)) !== null;
    } catch {
      held = null;
    }
    if (held !== null && stored === null) stored = held;
    // A sign-in learned while the read was in flight is newer than the store.
    if (promise === null) publish(!(held ?? false));
  })();
  return loading;
}

/**
 * An account has signed in on this phone: the welcome credits are not promised
 * to a guest here again. Called for the account signed in now
 * (`useWelcomeCreditsQuery`); the first sign-in's record is kept.
 */
export function endWelcomePromise(now = new Date().toISOString()) {
  publish(false);
  if (stored === true) return;
  let write: Promise<void>;
  try {
    write = AsyncStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, now);
  } catch {
    return;
  }
  write.then(
    () => {
      stored = true;
    },
    () => undefined,
  );
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
