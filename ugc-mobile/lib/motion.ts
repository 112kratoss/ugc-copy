import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, type ViewStyle } from 'react-native';

import { appTheme } from '@/lib/theme';

function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    // Some focused component tests intentionally provide a minimal react-native mock.
    return undefined;
  }
}

const animatedApi = optionalNativeExport(() => Animated);
const accessibilityApi = optionalNativeExport(() => AccessibilityInfo);

type ReducedMotionSubscription = { remove?: () => void } | undefined;

const reducedMotionSubscribers = new Set<() => void>();
let reducedMotionSnapshot = false;
let reducedMotionSubscription: ReducedMotionSubscription;
let reducedMotionStoreActive = false;
let reducedMotionReadVersion = 0;

function createValue(initialValue: number) {
  const Value = animatedApi?.Value;
  return Value ? new Value(initialValue) : null;
}

function publishReducedMotion(enabled: boolean) {
  if (reducedMotionSnapshot === enabled) return;

  reducedMotionSnapshot = enabled;
  reducedMotionSubscribers.forEach((notify) => notify());
}

function startReducedMotionStore() {
  if (reducedMotionStoreActive) return;

  reducedMotionStoreActive = true;
  const readVersion = ++reducedMotionReadVersion;
  const preference = accessibilityApi?.isReduceMotionEnabled?.();

  if (preference) {
    void preference
      .then((enabled) => {
        if (reducedMotionStoreActive && readVersion === reducedMotionReadVersion) {
          publishReducedMotion(enabled);
        }
      })
      .catch(() => {
        // Keep the safe default when the platform preference cannot be read.
      });
  }

  reducedMotionSubscription = accessibilityApi?.addEventListener?.(
    'reduceMotionChanged',
    publishReducedMotion,
  );
}

function stopReducedMotionStore() {
  if (!reducedMotionStoreActive) return;

  reducedMotionStoreActive = false;
  reducedMotionReadVersion += 1;
  reducedMotionSubscription?.remove?.();
  reducedMotionSubscription = undefined;
}

function subscribeToReducedMotion(notify: () => void) {
  reducedMotionSubscribers.add(notify);
  startReducedMotionStore();

  return () => {
    reducedMotionSubscribers.delete(notify);
    if (reducedMotionSubscribers.size === 0) stopReducedMotionStore();
  };
}

function getReducedMotionSnapshot() {
  return reducedMotionSnapshot;
}

/** Tracks the operating-system motion preference and safely falls back in tests/web. */
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionSnapshot,
  );
}

/**
 * Shared press feedback: a very small scale change with a visible keyboard focus state.
 * Motion is removed completely when the OS reduced-motion preference is enabled.
 */
export function usePressMotion(disabled = false) {
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const [scale] = useState<Animated.Value | null>(() => createValue(1));

  const animateScale = useCallback((toValue: number, duration: number) => {
    if (!scale) return;

    scale.stopAnimation();
    if (reducedMotion || !animatedApi?.timing) {
      scale.setValue(1);
      return;
    }

    animatedApi.timing(scale, {
      toValue,
      duration,
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, scale]);

  useEffect(() => {
    if (disabled || reducedMotion) scale?.setValue(1);
  }, [disabled, reducedMotion, scale]);

  return {
    animatedStyle: scale
      ? ({ transform: [{ scale }] } as Animated.WithAnimatedValue<ViewStyle>)
      : undefined,
    focused,
    onBlur: () => setFocused(false),
    onFocus: () => setFocused(true),
    onPressIn: () => {
      if (!disabled) {
        animateScale(appTheme.motion.scale.pressed, appTheme.motion.duration.pressIn);
      }
    },
    onPressOut: () => animateScale(1, appTheme.motion.duration.pressOut),
    reducedMotion,
  };
}

/**
 * Spring-driven 0->1 progress for selection states. Mirrors `useAnimatedState`
 * but settles with a spring instead of a fixed curve, which is what makes a
 * selection read as expressive rather than merely animated. Reduced motion
 * snaps instantly, same as everywhere else in this module.
 */
export function useSpringState(active: boolean) {
  const reducedMotion = useReducedMotion();
  const [progress] = useState<Animated.Value | null>(() => createValue(active ? 1 : 0));

  useEffect(() => {
    if (!progress) return;

    progress.stopAnimation();
    if (reducedMotion || !animatedApi?.spring) {
      progress.setValue(active ? 1 : 0);
      return;
    }

    animatedApi.spring(progress, {
      toValue: active ? 1 : 0,
      tension: appTheme.motion.spring.tension,
      friction: appTheme.motion.spring.friction,
      useNativeDriver: true,
    }).start();
  }, [active, progress, reducedMotion]);

  return progress;
}

/** Animates binary state changes such as a switch thumb; reduced motion updates instantly. */
export function useAnimatedState(active: boolean) {
  const reducedMotion = useReducedMotion();
  const [progress] = useState<Animated.Value | null>(() => createValue(active ? 1 : 0));

  useEffect(() => {
    if (!progress) return;

    progress.stopAnimation();
    if (reducedMotion || !animatedApi?.timing) {
      progress.setValue(active ? 1 : 0);
      return;
    }

    animatedApi.timing(progress, {
      toValue: active ? 1 : 0,
      duration: appTheme.motion.duration.state,
      useNativeDriver: true,
    }).start();
  }, [active, progress, reducedMotion]);

  return progress;
}
