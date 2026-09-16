/**
 * Foreground time an image may take to display, or a feed video to show its
 * first frame, before it is treated as stalled.
 *
 * Before this, recovery only began at an error callback. A request or native
 * view that produced neither success nor error left a thumbhash — or nothing —
 * on screen indefinitely, which is what the reader saw when tiles stayed blurred
 * until the app was restarted (2026-09-16 Creations reliability audit, C6, C9).
 */
export const MEDIA_DISPLAY_DEADLINE_MS = 15_000;

/** How long a stalled image waits before asking again for a recovery slot. */
export const MEDIA_RECOVERY_WAIT_MS = 1_500;
/** Waiting for another screen's recovery must also end in an actionable state. */
export const MEDIA_RECOVERY_MAX_WAIT_MS = 15_000;

/** Stalled images reloading at once, app-wide. */
export const MAX_CONCURRENT_MEDIA_RECOVERIES = 2;

export type MediaRecoverySlot = { release: () => void };

/**
 * A small counting semaphore. When many images stall together — the shape of a
 * network or native-loader problem rather than one bad file — reloading them all
 * at once repeats the load that stalled them; a couple at a time recovers the
 * screen without a stampede.
 */
export function createMediaRecoveryBudget(limit: number) {
  let active = 0;
  return {
    tryAcquire(): MediaRecoverySlot | null {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
    activeCount() {
      return active;
    },
  };
}

export const mediaRecoveryBudget = createMediaRecoveryBudget(MAX_CONCURRENT_MEDIA_RECOVERIES);

export type ImageStallStage = 'no-response' | 'downloading' | 'decoded-not-displayed';

/**
 * Where a stalled image got to, from the loader's own callbacks: nothing at all,
 * bytes arriving but no decoded image, or decoded but never displayed. Source,
 * decode and display failures need different fixes, and the diagnostics log is
 * how the next occurrence tells them apart.
 */
export function classifyImageStall(progress: { progressed: boolean; loaded: boolean }): ImageStallStage {
  if (progress.loaded) return 'decoded-not-displayed';
  if (progress.progressed) return 'downloading';
  return 'no-response';
}
