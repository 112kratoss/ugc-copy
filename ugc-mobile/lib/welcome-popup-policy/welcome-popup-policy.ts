/**
 * The welcome-credits popup's rules, in one copy the app and the web share by
 * relative import (owner, 2026-11-09: "the kling one looks live and cheerful",
 * a Claim button and a celebration; redesigned the same day: "the credits
 * increasing ... like games with filling animations", confetti "with a premium
 * feel", the popup closing as the confetti pops; on 2026-11-09 the web was to
 * have "all the design and functionalities also").
 *
 * Who it is offered to: a signed-in account that has its creator name and has
 * not claimed the credits, on a screen that offers it (the app's Home, the
 * web's Home and creators, and the page a sign-up came back to), until it is
 * closed. Each client keeps its own memory of a close (the app's lasts until
 * the next start, the web's until the browser session ends) and says which of
 * its screens offer it.
 *
 * The fill: once the claim lands, the ring and the figure count up from 0 to
 * the amount as a game's counter does, fast off the mark and slowing into the
 * landing, never more than one credit a frame.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */

/** What the welcome-credits answer says, as far as the popup reads it. */
export type WelcomePopupAnswer = {
  status?: string | null;
  identityComplete?: boolean | null;
};

export function shouldShowWelcomePopup({
  signedIn,
  welcome,
  offeredHere,
  dismissed,
}: {
  signedIn: boolean;
  welcome: WelcomePopupAnswer | null | undefined;
  /** The screen in front is one that offers it. */
  offeredHere: boolean;
  /** Closed already, for as long as the client remembers a close. */
  dismissed: boolean;
}): boolean {
  return signedIn && offeredHere && !dismissed
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
 * start, distinct taps at the end. (The web has no haptics.)
 */
export function welcomeCountUpTicks(amount: number): number[] {
  const ticks: number[] = [];
  for (let value = 1; value < amount; value += 1) ticks.push(value);
  return ticks;
}
