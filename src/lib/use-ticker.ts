'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The current time, ticking while `enabled`. Null in server HTML and on the
 * first client render: a time read during render differed between the two,
 * so any text derived from it (an elapsed count, "Ns ago") raised a hydration
 * error whenever a run was in progress on Home.
 */
let lastTickMs = Date.now();

function getSnapshot() {
  return lastTickMs;
}

function getServerSnapshot(): number | null {
  return null;
}

export function useTicker(enabled: boolean, intervalMs = 1000): number | null {
  const subscribe = useCallback((onStoreChange: () => void) => {
    // Fresh on mount, ticking only while something is running.
    lastTickMs = Date.now();
    onStoreChange();
    if (!enabled) {
      return () => undefined;
    }
    const intervalId = window.setInterval(() => {
      lastTickMs = Date.now();
      onStoreChange();
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
