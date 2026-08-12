export function scheduleIdleWork(callback: () => void, timeout = 1_000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout });
    return () => {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(handle);
      }
    };
  }

  const handle = window.setTimeout(callback, 80);
  return () => window.clearTimeout(handle);
}

/**
 * Waits for a genuine quiet period before moving work onto the browser's idle
 * queue. `requestIdleCallback`'s timeout is only a maximum wait; repeatedly
 * cancelling and rescheduling it does not make it a debounce on browsers whose
 * idle callback fires immediately (or whose fallback fires after 80ms).
 *
 * Keep this separate from `scheduleIdleWork`: chunk warming wants the first
 * available idle slice, while cache serialization should happen only after its
 * rapidly-changing inputs have settled.
 */
export function scheduleIdleDebouncedWork(
  callback: () => void,
  quietPeriod: number,
  idleTimeout = 1_000,
): () => void {
  let cancelIdleWork: (() => void) | null = null;
  const quietHandle = window.setTimeout(() => {
    cancelIdleWork = scheduleIdleWork(callback, idleTimeout);
  }, Math.max(0, quietPeriod));

  return () => {
    window.clearTimeout(quietHandle);
    cancelIdleWork?.();
  };
}
