import { useEffect, useRef, useState } from 'react';
import type { View } from 'react-native';
import {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  SEARCH_ENTRANCE,
  searchEntranceStart,
  type SearchEntranceOrigin,
  type SearchFieldFrame,
} from '@/lib/search-entrance';

/**
 * The search screen's entrance and exit (lib/search-entrance.ts says why):
 * one progress, 0 at the pressed control and 1 at rest, sprung on the UI
 * thread, from which the field's capsule, its magnifier and text, the back
 * button and the rest of the screen each take their part. The field's frame
 * starts as the header's own numbers and is corrected once measured.
 *
 * `touchable` turns true once the field has nearly arrived; until then the
 * screen takes no tap, so the second tap of a double tap does nothing.
 */
export function useSearchEntrance({
  origin,
  reducedMotion,
  restingFrame,
  iconSize,
  iconInset,
}: {
  origin: SearchEntranceOrigin | null;
  reducedMotion: boolean;
  restingFrame: SearchFieldFrame;
  iconSize: number;
  iconInset: number;
}) {
  // Decided once, at mount: the opening is over by the time either could change.
  const [moving] = useState(() => !reducedMotion);
  const [from] = useState(() => (moving ? origin : null));
  const progress = useSharedValue(moving ? 0 : 1);
  const start = useSharedValue(searchEntranceStart(from, restingFrame, { iconSize, iconInset }));
  const [touchable, setTouchable] = useState(!moving);

  useEffect(() => {
    if (!moving) return undefined;
    progress.set(withSpring(1, SEARCH_ENTRANCE.spring));
    const timer = setTimeout(() => setTouchable(true), SEARCH_ENTRANCE.touchesAfterMs);
    return () => clearTimeout(timer);
  }, [moving, progress]);

  // Where the field really is, once laid out: on Fabric the measure answers at once.
  const fieldRef = useRef<View>(null);
  const onFieldLayout = () => {
    if (!from) return;
    fieldRef.current?.measureInWindow?.((x, y, width, height) => {
      if (width > 0 && height > 0) start.set(searchEntranceStart(from, { x, y, width, height }, { iconSize, iconInset }));
    });
  };

  /**
   * Close: the same motion back into the control, then `pop` once it has
   * landed, and the navigator fades the page back in. At once without motion.
   */
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    // A screen left another way (the back swipe) never pops again later.
    if (popTimer.current) clearTimeout(popTimer.current);
  }, []);
  const exit = (pop: () => void) => {
    if (!moving) {
      pop();
      return;
    }
    if (popTimer.current) return;
    setTouchable(false);
    progress.set(withTiming(0, { duration: SEARCH_ENTRANCE.exitMs, easing: Easing.out(Easing.cubic) }));
    popTimer.current = setTimeout(pop, SEARCH_ENTRANCE.popAfterMs);
  };

  // The capsule: from the control's frame to the field's own.
  const capsuleStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const s = start.get();
    return {
      left: s.left * (1 - p),
      top: s.top * (1 - p),
      right: s.right * (1 - p),
      bottom: s.bottom * (1 - p),
    };
  });
  // A round button's own skin over the capsule as it starts, gone before half-way.
  const buttonSkinStyle = useAnimatedStyle(() => ({
    opacity: start.get().textShown ? 0 : interpolate(progress.get(), [0, 0.5], [1, 0], Extrapolation.CLAMP),
  }));
  const iconStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const s = start.get();
    return { transform: [{ translateX: s.iconX * (1 - p) }, { translateY: s.iconY * (1 - p) }] };
  });
  // The field's text travels with its magnifier: a bar's is there from the
  // start; a button has none, so it arrives once the capsule has room for it.
  const textStyle = useAnimatedStyle(() => {
    const p = progress.get();
    const s = start.get();
    return {
      opacity: s.textShown ? 1 : interpolate(p, [0.45, 0.95], [0, 1], Extrapolation.CLAMP),
      transform: [{ translateX: s.iconX * (1 - p) }, { translateY: s.iconY * (1 - p) }],
    };
  });
  // The back button comes in from its edge.
  const leadingStyle = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: interpolate(p, [0.25, 0.9], [0, 1], Extrapolation.CLAMP),
      transform: [{ translateX: -10 * (1 - p) }],
    };
  });
  // Tabs and what is under them rise into place behind the field.
  const contentStyle = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: interpolate(p, [0.2, 0.85], [0, 1], Extrapolation.CLAMP),
      transform: [{ translateY: 12 * (1 - p) }],
    };
  });

  return {
    touchable,
    fieldRef,
    onFieldLayout,
    exit,
    styles: { capsuleStyle, buttonSkinStyle, iconStyle, textStyle, leadingStyle, contentStyle },
  };
}
