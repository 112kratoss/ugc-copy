/**
 * The one place the app records that it is in the middle of something a reload
 * would ruin.
 *
 * OTA updates apply by restarting the JS bundle. That is invisible and free at
 * a cold start, and destructive in the middle of work: a generation loses its
 * live progress view (`lastPredictionId` in media-creation-screen is component
 * state, so the render survives on the server but the screen watching it does
 * not), an upload restarts from zero, and a purchase flow drops mid-transaction.
 *
 * Screens declare their own busy windows here rather than the update layer
 * reaching into them, because the update layer runs at the root and the busy
 * state lives in leaves. A screen that knows it is busy is the only honest
 * source; anything else is the root guessing.
 *
 * Locks are held by a token, not a boolean, so two overlapping activities
 * cannot release each other's claim. Release is idempotent — calling it twice,
 * or after an unmount, is a no-op.
 */

const activeLocks = new Map<symbol, string>();

const listeners = new Set<(busy: boolean) => void>();

function notify() {
  const busy = activeLocks.size > 0;
  for (const listener of listeners) listener(busy);
}

/**
 * Claim the app as busy for `reason`. Returns the release function — wire it
 * straight into a `useEffect` cleanup so an unmount can never strand a lock:
 *
 *   useEffect(() => {
 *     if (!isGenerating) return;
 *     return acquireActivityLock('generation');
 *   }, [isGenerating]);
 */
export function acquireActivityLock(reason: string): () => void {
  const token = Symbol(reason);
  activeLocks.set(token, reason);
  notify();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks.delete(token);
    notify();
  };
}

/** True while any screen holds a lock. */
export function hasActiveWork(): boolean {
  return activeLocks.size > 0;
}

/** Every reason currently held, for logging and for the update summary. */
export function activeWorkReasons(): string[] {
  return [...new Set(activeLocks.values())].sort();
}

/** Subscribe to busy/idle transitions. Returns an unsubscribe function. */
export function subscribeToActivity(listener: (busy: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. Never call this from app code. */
export function __resetActivityLocksForTest() {
  activeLocks.clear();
  listeners.clear();
}
