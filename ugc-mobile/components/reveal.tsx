import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';

import { MotionView, useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

/**
 * Content arriving, not appearing: the first page of a list fades and rises
 * into place with a short stagger. The animation is decided once, at mount,
 * so a recycled list cell never replays it while scrolling — only cells that
 * mount with `enabled` (the first page) ever move.
 */
const REVEAL_DURATION_MS = appTheme.motion.duration.reveal;
const REVEAL_STAGGER_MS = 55;
const REVEAL_MAX_STAGGER_STEPS = 6;
const REVEAL_RISE = 16;

function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function Reveal({
  index = 0,
  enabled = true,
  afterMount = false,
  children,
  style,
}: {
  index?: number;
  enabled?: boolean;
  /**
   * Start the fade two frames after the content mounts, not with the mount:
   * a large block (search's ideas to start from) took longer than a frame to
   * mount, and the fade's first frame, waiting on it, was late (Animation
   * Hitches on the iPhone 16e, 2026-11-14). Mounted still and unseen, it then
   * fades with nothing else to wait for.
   */
  afterMount?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  const [progress] = useState<Animated.Value | null>(() => (
    enabled && !reducedMotion
      ? optionalNativeExport(() => new Animated.Value(0)) ?? null
      : null
  ));
  const [delay] = useState(() => Math.min(index, REVEAL_MAX_STAGGER_STEPS) * REVEAL_STAGGER_MS);

  useEffect(() => {
    if (!progress) return undefined;

    const timing = optionalNativeExport(() => Animated.timing);
    if (reducedMotion || !timing) {
      progress.setValue(1);
      return undefined;
    }

    const animation = timing(progress, {
      toValue: 1,
      duration: REVEAL_DURATION_MS,
      delay,
      easing: optionalNativeExport(() => Easing.out(Easing.cubic)),
      useNativeDriver: true,
    });
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!afterMount || !raf) {
      animation.start();
      return () => animation.stop();
    }
    let frame = raf(() => {
      frame = raf(() => animation.start());
    });
    return () => {
      cancelAnimationFrame(frame);
      animation.stop();
    };
  }, [afterMount, delay, progress, reducedMotion]);

  if (!progress) {
    return <View style={style}>{children}</View>;
  }

  return (
    <MotionView
      style={[
        style,
        {
          opacity: progress,
          transform: [{
            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [REVEAL_RISE, 0] }),
          }],
        },
      ]}
    >
      {children}
    </MotionView>
  );
}
