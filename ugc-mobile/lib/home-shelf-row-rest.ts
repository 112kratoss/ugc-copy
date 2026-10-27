import type { NativeScrollEvent } from 'react-native';

import { SHOWCASE_SETTLE_CONFIRM_MS } from './showcase-feed-activation';

/** Where the shelf's row rests: its scroll offset, and how wide it shows. */
export interface HomeShelfRowRest {
  scrollX: number;
  viewportWidth: number;
}

type RowScrollEvent = Pick<NativeScrollEvent, 'contentOffset' | 'layoutMeasurement'> & {
  /** iOS, with the finger's lift: where the snap will land. */
  targetContentOffset?: { x: number; y: number };
};

/**
 * Tells when the Home shelf's row has come to rest, and where.
 *
 * A finger's lift is not rest: the row snaps to a card's edge after it, and a
 * fling coasts on. React Native reports that movement as momentum on both
 * platforms, so its end is the rest. A lift no momentum follows rests where
 * the snap puts it, so the lift waits the feed's own confirm window
 * (`SHOWCASE_SETTLE_CONFIRM_MS`, `lib/showcase-feed-activation.ts`) for
 * momentum to begin and reports only then. iOS says with the lift where the
 * snap lands (`targetContentOffset`); elsewhere the lift's own offset is the
 * best there is. A momentum end under a finger already back on the row is the
 * last fling expiring: that finger's lift reports the rest.
 *
 * A scroll with no finger in it (TalkBack moving to a card off screen, a
 * keyboard's focus) brings no drag or momentum event on Android, only scroll
 * events: such a scroll rests once its events have stopped for the same
 * window. During a drag or a coast scroll events are left to those.
 */
export function createHomeShelfRowRest(onRest: (rest: HomeShelfRowRest) => void) {
  let dragging = false;
  let coasting = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  };
  const restAfterConfirm = (rest: HomeShelfRowRest) => {
    cancel();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      onRest(rest);
    }, SHOWCASE_SETTLE_CONFIRM_MS);
  };

  return {
    dragBegin() {
      dragging = true;
      cancel();
    },
    dragEnd(event: RowScrollEvent) {
      dragging = false;
      restAfterConfirm({
        scrollX: event.targetContentOffset?.x ?? event.contentOffset.x,
        viewportWidth: event.layoutMeasurement.width,
      });
    },
    momentumBegin() {
      coasting = true;
      cancel();
    },
    momentumEnd(event: RowScrollEvent) {
      coasting = false;
      cancel();
      if (dragging) return;
      onRest({ scrollX: event.contentOffset.x, viewportWidth: event.layoutMeasurement.width });
    },
    scrolled(event: RowScrollEvent) {
      if (dragging || coasting) return;
      restAfterConfirm({ scrollX: event.contentOffset.x, viewportWidth: event.layoutMeasurement.width });
    },
    /** For unmount: a rest still being confirmed goes unreported. */
    cancel,
  };
}
