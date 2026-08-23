import { Heart } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { MotionView, useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { getSaveHeartIconProps } from '@/lib/viewer-actions';

function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The save heart on feed and detail cards. Saving is optimistic, so the icon
 * flips the instant the user taps; this makes that flip visible as a pop —
 * compress, overshoot, settle — rather than a colour swap. Unsaving gets a
 * quieter single settle, and reduced motion gets the plain swap.
 */
export function SaveHeart({
  saved,
  size,
  enabled = true,
}: {
  saved: boolean;
  size: number;
  enabled?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [scale] = useState<Animated.Value | null>(() => optionalNativeExport(() => new Animated.Value(1)) ?? null);
  const previousSaved = useRef(saved);

  useEffect(() => {
    if (previousSaved.current === saved) return;
    previousSaved.current = saved;
    if (!scale || reducedMotion) return;

    const spring = optionalNativeExport(() => Animated.spring);
    const sequence = optionalNativeExport(() => Animated.sequence);
    if (!spring || !sequence) return;

    scale.stopAnimation();
    scale.setValue(saved ? 0.7 : 0.9);
    sequence(saved
      ? [
        spring(scale, { toValue: 1.3, ...appTheme.motion.spring.pressIn, useNativeDriver: true }),
        spring(scale, { toValue: 1, ...appTheme.motion.spring.release, useNativeDriver: true }),
      ]
      : [spring(scale, { toValue: 1, ...appTheme.motion.spring.release, useNativeDriver: true })]
    ).start();
  }, [reducedMotion, saved, scale]);

  return (
    <MotionView style={scale ? { transform: [{ scale }] } : undefined}>
      <Heart size={size} {...getSaveHeartIconProps({ isSaved: saved, enabled })} />
    </MotionView>
  );
}
