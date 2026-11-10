import { useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTransitionProgress } from 'react-native-screens';

import {
  APPLE_ZOOM_RETURN_LANDS_AFTER_MS,
  holdAppleZoomReturnPicture,
  isAppleZoomReturnPictureHeld,
  releaseAppleZoomReturnPicture,
} from '@/lib/apple-zoom-surface';
import type { ReelTouches } from '@/lib/reel-touches';
import { listenForScreenLeaving } from '@/lib/use-screen-leaving';

/**
 * The share of the push after which the reel's top controls come in. The
 * progress follows the zoom's spring, so 0.9 arrives about 150 ms into it; the
 * controls then take a state change (180 ms) to come in, by which time the
 * tile's picture has crossfaded away, about 330 ms in (simulator, 2026-11-03).
 */
const TOP_CONTROLS_SHOW_AT = 0.9;
/** Shown by then whatever the transition reported, so a lost event never strands them. */
const TOP_CONTROLS_DEADLINE_MS = 700;

/**
 * Says when the reel's Back and sound controls show (lib/viewer-top-controls.ts)
 * on a reel UIKit's zoom opened. The zoom draws the tile's picture over the
 * reel's media rect until it has crossfaded to the reel, and these controls sit
 * across that rect's top edge whenever a picture leaves a band about as tall as
 * their row (a 9:16 post on an iPhone 17 Pro). Drawn from the first frame,
 * their top showed over the band while the flying picture still covered the
 * rest (filmed 2026-11-03). So they come in once the push has crossfaded, go as
 * a close begins, and come back if that close is let go of.
 *
 * A close holds them back for as long as it lasts, and Back for good. Begun
 * before they had come in (a swipe back straight after a mis-tap), a close
 * used to run on into the push's cue: the deadline fired, or the close's own
 * progress passed 0.9, and they faded in over the shrinking reel.
 *
 * A component of its own, drawing nothing: the transition's context is a new
 * object whenever the screen renders, so a screen that read it and also set
 * its own options re-rendered itself without end.
 */
export function AppleZoomTopControlsCue({ onShownChange }: { onShownChange: (shown: boolean) => void }) {
  const navigation = useNavigation();
  const { progress } = useTransitionProgress();
  // The push has crossfaded to the reel.
  const [opened, setOpened] = useState(false);
  // A close under way: one the reader began with a gesture, which can be let go
  // of, or one that removes the reel from JS, which it does not outlive.
  const [closing, setClosing] = useState<'gesture' | 'removed' | null>(null);
  const shown = opened && closing === null;

  // The push is listened to only while it can still bring them in: a listener
  // on its progress is an event on the JS thread every frame.
  useEffect(() => {
    if (opened || closing) return undefined;
    const id = progress.addListener(({ value }) => {
      if (value >= TOP_CONTROLS_SHOW_AT) setOpened(true);
    });
    const deadline = setTimeout(() => setOpened(true), TOP_CONTROLS_DEADLINE_MS);
    return () => {
      progress.removeListener(id);
      clearTimeout(deadline);
    };
  }, [closing, opened, progress]);

  useEffect(() => {
    onShownChange(shown);
  }, [onShownChange, shown]);

  useEffect(() => {
    let gestureClose = false;
    const unsubscribers = [
      // Back, and anything else that removes the reel from JS.
      navigation.addListener('beforeRemove', () => setClosing('removed')),
      // A close the reader starts with a gesture, until it is let go of, when
      // the reel is back and up. The same event announces a screen pushed over
      // the reel, when the reel is no longer the focused route; that one keeps
      // its controls.
      listenForScreenLeaving(navigation, (leaving) => {
        if (leaving && navigation.isFocused()) {
          gestureClose = true;
          setClosing((current) => current ?? 'gesture');
        } else if (!leaving && gestureClose) {
          gestureClose = false;
          setOpened(true);
          setClosing((current) => (current === 'gesture' ? null : current));
        }
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [navigation]);

  return null;
}

/**
 * How far into its progress a close has to be for the reel's page to have
 * gone, beside the time it has had (`APPLE_ZOOM_RETURN_LANDS_AFTER_MS`). For a
 * close no finger holds the progress follows the zoom's spring, 0.99 about
 * 290 ms in (simulator, 2026-11-10). While a finger drags it follows the
 * finger, and reached 1 under an edge swipe held at the far edge, so it says
 * nothing until the finger has left.
 */
const RETURN_LANDED_AT = 0.99;

/**
 * How long before a close is heard of a touch React Native was told was
 * cancelled still counts as part of it. A gesture outside React Native that
 * takes a touch over cancels it there (`RCTSurfaceTouchHandler`), and would do
 * so as it recognizes, just before the navigator reports the close.
 */
const RETURN_CANCEL_LEAD_MS = 500;

/**
 * Says when a close has landed the reel in its tile, and lets the tile's
 * picture go then (lib/apple-zoom-surface.ts), so the tile draws itself again,
 * badges and all. UIKit keeps the picture it flew over the tile until its
 * transition ends, which it reports 0.5 to 1.1 s after the picture has
 * stopped (simulator, 2026-11-10): left to that, a tile's badge came back a
 * second after its picture had.
 *
 * Landed means all of: a close of this reel is under way, no finger is on the
 * reel, `APPLE_ZOOM_RETURN_LANDS_AFTER_MS` have passed since the later of the
 * close's start and the last finger's lift, and the transition's progress is
 * past `RETURN_LANDED_AT`.
 *
 * A finger React Native lost by a cancel may still be dragging the close, and
 * no lift will be heard for it: such a close is left to land when the reel
 * goes, at the end of the pop (`useAppleZoomRetarget`), late but never under
 * the finger. Each close the edge swipe made on the simulator sent a lift.
 *
 * A close let go of before it commits brings the reel back and lands nothing,
 * and the picture is held again if it had already been let go, so the next
 * close carries it too.
 *
 * A component of its own, drawing nothing, for the reason
 * `AppleZoomTopControlsCue` is one.
 */
export function AppleZoomReturnLandingCue({
  surfaceId,
  itemId,
  touches,
}: {
  /** The surface of the tile the reel closes into, and the post the reader is on. */
  surfaceId: string | null;
  itemId: string | null;
  touches: ReelTouches;
}) {
  const navigation = useNavigation();
  const { progress } = useTransitionProgress();
  useEffect(() => {
    if (!surfaceId || !itemId) return undefined;
    let leavingAt: number | null = null;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let progressId: string | null = null;
    // This close let the tile's picture go, so a cancel of it holds it again.
    let released = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (progressId) progress.removeListener(progressId);
      progressId = null;
      leavingAt = null;
    };
    const check = () => {
      if (leavingAt === null || touches.active()) return;
      const lifted = touches.endedAt();
      // A finger React Native lost by a cancel, during this close or just
      // before it was heard of: left to the end of the pop.
      if (lifted !== null && touches.endedByCancel() && lifted >= leavingAt - RETURN_CANCEL_LEAD_MS) return;
      // Nothing has held the close since its start, or since the lift of the
      // finger that dragged it.
      const since = Math.max(lifted ?? leavingAt, leavingAt);
      const wait = since + APPLE_ZOOM_RETURN_LANDS_AFTER_MS - performance.now();
      if (wait > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, wait);
        return;
      }
      // Not there yet: the next report of its progress asks again.
      if (latest < RETURN_LANDED_AT) return;
      stop();
      released = isAppleZoomReturnPictureHeld(surfaceId, itemId);
      releaseAppleZoomReturnPicture(surfaceId, itemId, false);
    };
    const unsubscribers = [
      // The same event announces a screen pushed over the reel, when the reel
      // is no longer the focused route: nothing is closing then.
      listenForScreenLeaving(navigation, (leaving) => {
        if (leaving && navigation.isFocused()) {
          leavingAt = performance.now();
          latest = 0;
          progressId ??= progress.addListener(({ value }) => {
            latest = value;
            check();
          });
          check();
        } else if (!leaving) {
          stop();
          // The close was let go of and the reel is back, still showing the
          // picture it held for the tile.
          if (released) holdAppleZoomReturnPicture(surfaceId, itemId);
          released = false;
        }
      }),
      touches.subscribe(check),
    ];
    return () => {
      stop();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [itemId, navigation, progress, surfaceId, touches]);
  return null;
}
