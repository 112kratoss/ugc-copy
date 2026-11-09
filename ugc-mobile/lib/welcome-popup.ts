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
