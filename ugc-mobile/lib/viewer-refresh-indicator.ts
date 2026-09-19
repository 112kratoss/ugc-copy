import { useEffect, useRef, useState } from 'react';

/**
 * The reel's refresh spinner, held back.
 *
 * Opening the reel refetches its source: 0.5–0.9 s warm and about 1.5 s cold
 * against the API (2026-09-18 check-up). The spinner used to appear the moment
 * the fetch began — on Android an indeterminate ProgressBar invalidating on
 * every vsync — so the reel's first second, its landing and hand-off fade, was
 * also spent re-recording and re-drawing a spinner nobody had asked for. A
 * refresh the reader did not start now shows its spinner only once it has been
 * pending this long; most warm refetches finish first and show nothing, the
 * way a reel app opens onto content rather than a spinner. A refresh the reader
 * asked for from the More sheet is feedback on their tap and shows at once.
 */
export const VIEWER_REFRESH_SPINNER_DELAY_MS = 900;

/** The rule in one place: shown once pending long enough, or at once when the reader asked. */
export function refreshSpinnerShown({ fetching, elapsedMs, requested }: { fetching: boolean; elapsedMs: number; requested: boolean }): boolean {
  return fetching && (requested || elapsedMs >= VIEWER_REFRESH_SPINNER_DELAY_MS);
}

/**
 * @param fetching whether the source is refetching now
 * @param manualRefreshes a count the screen bumps on each refresh the reader asked for
 */
export function useViewerRefreshSpinner({ fetching, manualRefreshes }: { fetching: boolean; manualRefreshes: number }): boolean {
  const [due, setDue] = useState(false);
  // The manual count the last finished fetch had reached: a bump above it is a
  // refresh the reader asked for, shown at once until that fetch ends.
  const [settledRefreshes, setSettledRefreshes] = useState(manualRefreshes);
  const wasFetching = useRef(fetching);
  useEffect(() => {
    if (wasFetching.current && !fetching) setSettledRefreshes(manualRefreshes);
    wasFetching.current = fetching;
  }, [fetching, manualRefreshes]);
  useEffect(() => {
    if (!fetching) {
      setDue(false);
      return undefined;
    }
    const timer = setTimeout(() => setDue(true), VIEWER_REFRESH_SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fetching]);
  return fetching && (due || manualRefreshes > settledRefreshes);
}
