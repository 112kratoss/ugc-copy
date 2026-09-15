import { useCallback, useEffect, useRef } from 'react';

import { subscribeToAppForeground } from './app-foreground';
import {
  INITIAL_PROFILE_REVALIDATION_GATE,
  canRevalidateProfileMedia,
  recordProfileRevalidationFailure,
  recordProfileRevalidationStart,
  recordProfileRevalidationSuccess,
  type ProfileRevalidationGate,
} from './profile-media-refresh';

/**
 * Keeps a profile library fresh from qualifying events only: the screen gaining
 * focus, the visible library changing, and the app returning to the foreground
 * while the screen is focused.
 *
 * A fetch settling is deliberately not an event. The effect this replaces listed
 * `isFetching` among its dependencies, so a refresh that failed — leaving the
 * data stale — started the next one the moment it finished (2026-09-16 Creations
 * reliability audit, C7). Each library keeps its own gate, which spaces attempts,
 * backs off after failures and honours a rate limit. The first load belongs to
 * the query itself, so nothing runs before a library has data.
 */
export function useProfileMediaRevalidation({
  enabled,
  scope,
  hasData,
  isFetching,
  isStale,
  refresh,
}: {
  /** Signed in, and the screen showing this library is focused. */
  enabled: boolean;
  /** Which library is visible; each keeps its own schedule. */
  scope: string;
  hasData: boolean;
  isFetching: boolean;
  isStale: boolean;
  /** Fetches the library's first page and merges it. Rejections count as failures. */
  refresh: (scope: string) => Promise<unknown>;
}) {
  const gates = useRef(new Map<string, ProfileRevalidationGate>());
  const latest = useRef({ hasData, isFetching, isStale, refresh });

  useEffect(() => {
    latest.current = { hasData, isFetching, isStale, refresh };
  });

  const revalidate = useCallback(() => {
    const current = latest.current;
    if (!current.hasData) return;
    const now = Date.now();
    const gate = gates.current.get(scope) ?? INITIAL_PROFILE_REVALIDATION_GATE;
    if (!canRevalidateProfileMedia({ gate, now, isFetching: current.isFetching, isStale: current.isStale })) return;

    gates.current.set(scope, recordProfileRevalidationStart(gate, now));
    const settle = (next: (gate: ProfileRevalidationGate) => ProfileRevalidationGate) => {
      gates.current.set(scope, next(gates.current.get(scope) ?? INITIAL_PROFILE_REVALIDATION_GATE));
    };
    void current.refresh(scope).then(
      () => settle(recordProfileRevalidationSuccess),
      (error: unknown) => settle((settled) => recordProfileRevalidationFailure(settled, error, Date.now()))
    );
  }, [scope]);

  useEffect(() => {
    if (enabled) revalidate();
  }, [enabled, revalidate]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeToAppForeground((foreground) => {
      if (foreground) revalidate();
    });
  }, [enabled, revalidate]);
}
