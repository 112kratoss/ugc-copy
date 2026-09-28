import { useEffect, useMemo } from 'react';
import { Animated } from 'react-native';
import { useTransitionProgress } from 'react-native-screens';

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
