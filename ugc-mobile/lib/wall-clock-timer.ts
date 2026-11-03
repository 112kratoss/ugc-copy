import { subscribeToAppForeground } from './app-foreground';

/** setTimeout's longest wait; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Calls `onReached` once the clock (`Date.now()`) has reached `timeMs`, and
 * returns a stop for the wait.
 *
 * One timer set for the whole wait cannot be trusted with it. A wait longer
 * than setTimeout's longest fires at once, so a long one is taken in parts,
 * each checked against the clock as it ends. And Android times a wait by a
 * clock that stops while the phone sleeps (`JavaTimerManager` counts from
 * `System.nanoTime`), so a wait the phone slept through ends late by as long
 * as it slept: a signed address on a screen left open overnight would be read
 * past its end until the timer caught up. So the clock is read again each time
 * the app comes back to the foreground.
 */
export function whenClockReaches(timeMs: number, onReached: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
    unsubscribe = () => {};
  };
  const wait = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (Date.now() < timeMs) {
        wait();
        return;
      }
      stop();
      onReached();
    }, Math.min(MAX_TIMER_MS, Math.max(0, timeMs - Date.now())));
  };
  unsubscribe = subscribeToAppForeground((foreground) => {
    if (foreground) wait();
  });
  wait();
  return stop;
}
