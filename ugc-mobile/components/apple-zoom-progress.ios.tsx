import { useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Animated } from 'react-native';
import { useTransitionProgress } from 'react-native-screens';

import { listenForScreenLeaving } from '@/lib/use-screen-leaving';
import { followZoomVeilTransition, type ZoomVeilDrop } from '@/lib/zoom-veil';

/**
 * Hands the reel's transition to the veil its tap dropped (lib/zoom-veil.ts).
 * UIKit's transition coordinator drives this graph on the native thread.
 */
export function AppleZoomProgress({ veil }: { veil: ZoomVeilDrop | null }) {
  const { progress, closing } = useTransitionProgress();
  const opacity = useMemo(() => {
    // Darken with the growing picture, never during route preparation. The
    // crossfade needs black early, while dismissal follows the finger linearly.
    const opening = progress.interpolate({
      inputRange: [0, 0.25, 1], outputRange: [0, 1, 1], extrapolate: 'clamp',
    });
    return Animated.add(
      Animated.multiply(Animated.subtract(1, closing), opening),
      Animated.multiply(closing, Animated.subtract(1, progress)),
    ).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  }, [closing, progress]);
  useEffect(() => (veil ? followZoomVeilTransition(veil, opacity) : undefined), [opacity, veil]);
  return null;
}

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
