import { useSyncExternalStore } from 'react';

/**
 * The welcome-credits popup (owner, 2026-11-09: "the kling one looks live and
 * cheerful", a Claim button, a celebration, haptics while the credits count
 * up; redesigned the same day: "the credits increasing with the haptics ...
 * like games with filling animations", confetti "with a premium feel", the
 * popup closing as the confetti pops). It offers the credits to a signed-in
 * account that has its creator name and has not claimed them yet, on Home and
 * on the screen a sign-up went back to (owner, 2026-11-09: "the page a sign-up
 * returns to"). Closing it waits until the next app start.
 */
const dismissedThisRun = new Set<string>();

/** Per account: one account closing it says nothing about the next to sign in. */
export function dismissWelcomePopupThisRun(userId: string) {
  dismissedThisRun.add(userId);
}

export function wasWelcomePopupDismissedThisRun(userId: string | null | undefined) {
  return Boolean(userId) && dismissedThisRun.has(userId!);
}

/** For tests: a fresh app start. */
export function resetWelcomePopupThisRun() {
  dismissedThisRun.clear();
  setReturnedTo(null);
}

/**
 * A route as expo-router's `usePathname()` names the screen it opens: without
 * its groups, query, hash or trailing slash (`/(tabs)/creator?tool=image` is
 * `/creator`, `/(tabs)` is `/`).
 */
export function welcomeRoutePath(route: string): string {
  const segments = route.split(/[?#]/, 1)[0]
    .split('/')
    .filter((segment) => segment && !/^\(.*\)$/.test(segment));
  if (segments[segments.length - 1] === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

/*
 * The screen a sign-up went back to: onboarding marks it as it leaves, with the
 * name saved, for the screen that asked for an account (a creator's Generate,
 * a Like, a Follow), and the popup offers the credits there as on Home. Kept
 * for the run, like a close.
 */
let returnedTo: string | null = null;
const returnListeners = new Set<() => void>();

function setReturnedTo(next: string | null) {
  if (next === returnedTo) return;
  returnedTo = next;
  returnListeners.forEach((listener) => listener());
}

export function markWelcomeReturn(route: string | null | undefined) {
  setReturnedTo(route ? welcomeRoutePath(route) : null);
}

export function welcomeReturnPath(): string | null {
  return returnedTo;
}

export function subscribeToWelcomeReturn(listener: () => void) {
  returnListeners.add(listener);
  return () => {
    returnListeners.delete(listener);
  };
}

/** The screen a sign-up went back to, for a component to follow. */
export function useWelcomeReturnPath(): string | null {
  return useSyncExternalStore(subscribeToWelcomeReturn, welcomeReturnPath, welcomeReturnPath);
}

/** Whether the screen in front offers the popup: Home, or the screen a sign-up went back to. */
export function isWelcomePopupPlace({ pathname, returnedTo: returned }: { pathname: string | null | undefined; returnedTo: string | null }) {
  if (!pathname) return false;
  const path = welcomeRoutePath(pathname);
  return path === '/' || (returned !== null && path === returned);
}

/**
 * Who it is offered to and the fill it counts up on are shared with the web
 * (`welcome-popup-policy/`); the app keeps only its memory of a close.
 */
export {
  shouldShowWelcomePopup,
  WELCOME_COUNT_UP_MS,
  welcomeCountUpTicks,
  welcomeFillProgress,
} from './welcome-popup-policy/welcome-popup-policy';
