import { useSyncExternalStore } from 'react';

/**
 * Whether the reel's close has set off (`useMediaZoomStage`'s `onCloseStart`):
 * it has gone out of sight, or its window has begun to shrink, with the screen
 * beneath round it. Its route stays until later, as late as the landing on
 * Android, so focus alone said "in front" for ~300 ms too long, and the reel's
 * light status bar and dark navigation bar stood over the light grid (review
 * of #947).
 *
 * Held apart from the reel's state and read by the system bars alone, so the
 * close setting off does not draw the reel again on its first frames.
 */
export interface ReelClosing {
  isClosing: () => boolean;
  setClosing: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createReelClosing(): ReelClosing {
  let closing = false;
  const listeners = new Set<() => void>();
  return {
    isClosing: () => closing,
    setClosing: () => {
      if (closing) return;
      closing = true;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useReelClosing(closing: ReelClosing) {
  return useSyncExternalStore(closing.subscribe, closing.isClosing, closing.isClosing);
}
