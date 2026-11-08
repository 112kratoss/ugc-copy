import type { WelcomeCreditResponse } from './types';

/**
 * The welcome-credits popup over Home (owner, 2026-11-09: "the kling one looks
 * live and cheerful", a Claim button, a celebration, haptics while the credits
 * count up; redesigned the same day: "the credits increasing with the haptics
 * ... like games with filling animations", confetti "with a premium feel",
 * the popup closing as the confetti pops). It offers the credits to a
 * signed-in account that has its creator name and has not claimed them yet.
 * Closing it waits until the next app start.
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
}

export function shouldShowWelcomePopup({
  signedIn,
  welcome,
  homeFocused,
  dismissed,
}: {
  signedIn: boolean;
  welcome: Pick<WelcomeCreditResponse, 'status' | 'identityComplete'> | null | undefined;
  homeFocused: boolean;
  dismissed: boolean;
}): boolean {
  return signedIn && homeFocused && !dismissed
    && Boolean(welcome?.identityComplete) && welcome?.status === 'eligible';
}

/** How long the figure takes to fill from 0 to the total once the claim lands. */
export const WELCOME_COUNT_UP_MS = 1300;

/**
 * How far the fill has got at `elapsed` ms, 0..1: a game's counter, fast off
 * the mark and slowing as it lands (ease-out quad), so the first credits fly
 * by in a blur of ticks and the last few arrive one at a time. (A cubic held
 * the figure on the second-to-last credit for half a second: a stall, not a
 * landing.)
 */
export function welcomeFillProgress(elapsed: number, duration = WELCOME_COUNT_UP_MS): number {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return 1 - (1 - t) ** 2;
}

/**
 * The credits at which the count-up gives a haptic tick: every single credit
 * on the way up, the last excluded (it gets the success haptic instead), as a
 * picker ticks past each row. The ease-out curve spaces them: a rattle at the
 * start, distinct taps at the end.
 */
export function welcomeCountUpTicks(amount: number): number[] {
  const ticks: number[] = [];
  for (let value = 1; value < amount; value += 1) ticks.push(value);
  return ticks;
}
