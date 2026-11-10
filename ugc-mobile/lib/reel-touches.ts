/**
 * Whether a finger is on the reel, and when the last one left it.
 *
 * UIKit's zoom closes the reel under a finger (a drag down, the edge swipe, a
 * pinch) and lets those touches reach React Native all the same, from the
 * first contact to the lift: an edge swipe held at the far edge for two
 * seconds sent its start, nothing while the close's progress went to 1 under
 * the finger, and its end at the lift (simulator, 2026-11-10). Nothing else
 * tells the app that the finger has let go of a close it was dragging: the
 * navigator reports the close's start and, up to a second after the page has
 * landed, its end (lib/use-screen-leaving.ts). `AppleZoomReturnLandingCue`
 * reads this to tell a close that is flying home from one still held under a
 * finger.
 */
export interface ReelTouches {
  /** For the reel's root view. They only read: no touch is claimed. */
  handlers: {
    onTouchStart: (event: ReelTouchEvent) => void;
    onTouchEnd: (event: ReelTouchEvent) => void;
    onTouchCancel: (event: ReelTouchEvent) => void;
  };
  /** Whether a finger is on the reel. */
  active: () => boolean;
  /** When the last finger left the reel, on `now`'s clock; null before any has. */
  endedAt: () => number | null;
  /**
   * Whether the last finger left by a cancel rather than a lift. React Native
   * cancels its touches when a gesture outside it takes them over
   * (`RCTSurfaceTouchHandler`), and that finger may still be on the glass.
   */
  endedByCancel: () => boolean;
  /** Hears each time the last finger leaves. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/** As much of a touch event as this reads: the fingers still down. */
export interface ReelTouchEvent {
  nativeEvent: { touches: ArrayLike<unknown> };
}

export function createReelTouches(now: () => number = () => performance.now()): ReelTouches {
  let down = 0;
  let endedAt: number | null = null;
  let cancelled = false;
  const listeners = new Set<() => void>();
  const read = (event: ReelTouchEvent, cancel: boolean) => {
    const was = down;
    // The fingers still on the screen after this event, the one that left out.
    down = event.nativeEvent.touches.length;
    if (was > 0 && down === 0) {
      endedAt = now();
      cancelled = cancel;
      listeners.forEach((listener) => listener());
    }
  };
  return {
    handlers: {
      onTouchStart: (event) => read(event, false),
      onTouchEnd: (event) => read(event, false),
      onTouchCancel: (event) => read(event, true),
    },
    active: () => down > 0,
    endedAt: () => endedAt,
    endedByCancel: () => cancelled,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
