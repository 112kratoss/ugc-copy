import type { WelcomeCreditResponse } from './types';

/**
 * The welcome-credits popup over Home (owner, 2026-11-09: "the kling one looks
 * live and cheerful", a Claim button, confetti, haptics while the credits count
 * up). It offers the credits to a signed-in account that has its creator name
 * and has not claimed them yet. Closing it waits until the next app start.
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

/** How long the figure takes to count up once the claim lands. */
export const WELCOME_COUNT_UP_MS = 900;

/**
 * The values at which the count-up gives a haptic tick: every `step` credits on
 * the way up, the last one excluded (it gets the success haptic instead).
 * 25 → 5, 10, 15, 20.
 */
export function welcomeCountUpTicks(amount: number, step = 5): number[] {
  const ticks: number[] = [];
  for (let value = step; value < amount; value += step) ticks.push(value);
  return ticks;
}
