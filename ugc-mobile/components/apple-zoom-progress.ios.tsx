import { useEffect, useMemo } from 'react';
import { Animated } from 'react-native';
import { useTransitionProgress } from 'react-native-screens';

import { bindNativeZoomVeil } from '@/lib/native-zoom-veil';

/** UIKit's transition coordinator drives this graph on the native thread. */
export function AppleZoomProgress() {
  const { progress, closing } = useTransitionProgress();
  const opacity = useMemo(() => Animated.subtract(1, Animated.multiply(closing, progress)).interpolate({
    inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp',
  }), [closing, progress]);
  useEffect(() => bindNativeZoomVeil(opacity), [opacity]);
  return null;
}
