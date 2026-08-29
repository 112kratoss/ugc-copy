import { useCallback, useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { AccessibilityInfo, Animated, Easing, View, type ViewStyle } from 'react-native';

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

/**
 * The view every press-motion consumer wraps itself in. Resolved once so the
 * component identity is stable across renders, and tolerant of the minimal
 * react-native mocks focused tests use: no Animated means a plain View, no
 * View means a passthrough.
 */
export const MotionView = (
  optionalNativeExport(() => Animated.View)
  ?? optionalNativeExport(() => View)
  ?? (({ children }: { children?: React.ReactNode }) => children ?? null)
) as typeof Animated.View;

export type MotionViewProps = ComponentProps<typeof Animated.View>;

type PressMotionOptions = {
  /** Scale to settle at while pressed; defaults to `appTheme.motion.scale.pressed`. */
  scale?: number;
};

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
 * Shared press feedback: the surface springs down under the finger and springs
 * back with a small rebound on release, plus a visible keyboard focus state.
 * Motion is removed completely when the OS reduced-motion preference is enabled.
 *
 * Theme reads stay inside the handlers on purpose: focused component tests
 * mock the theme down to a few colours and never press anything.
 */
export function usePressMotion(disabled = false, options?: PressMotionOptions) {
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const [scale] = useState<Animated.Value | null>(() => createValue(1));
  const pressedScale = options?.scale;

  const animateScale = useCallback((toValue: number, phase: 'pressIn' | 'release') => {
    if (!scale) return;

    scale.stopAnimation();
    if (reducedMotion || !animatedApi?.spring) {
      scale.setValue(1);
      return;
    }

    animatedApi.spring(scale, {
      toValue,
      ...appTheme.motion.spring[phase],
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
        animateScale(pressedScale ?? appTheme.motion.scale.pressed, 'pressIn');
      }
    },
    onPressOut: () => animateScale(1, 'release'),
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

/**
 * Cross-fade progress for a value that changes to arbitrary new values rather
 * than toggling between two known states — an adaptive colour, say, where there
 * is no "off" to animate back to.
 *
 * Returns the outgoing value, the incoming one, and a 0->1 progress that
 * restarts on every change. Stack two opaque layers, hold the outgoing value
 * underneath and fade the incoming one in over it: opacity drives on the native
 * thread, where an animated `backgroundColor` has to round-trip through JS on
 * every frame — which is the one thing a colour that changes during a scroll
 * cannot afford. Reduced motion lands on the new value immediately.
 */
export function useCrossFade<T>(value: T) {
  const reducedMotion = useReducedMotion();
  const [progress] = useState<Animated.Value | null>(() => createValue(1));
  const [pair, setPair] = useState({ from: value, to: value });

  // Adjusted during render rather than in an effect: React re-runs the component
  // before committing, so both layers are always painted from the same frame.
  // Deferring it would show the incoming value on both layers for one frame, and
  // the fade would have nothing left to fade from.
  if (!Object.is(pair.to, value)) setPair({ from: pair.to, to: value });

  useEffect(() => {
    if (!progress) return;

    progress.stopAnimation();
    // Nothing to cross-fade on the first commit, and nothing to cross-fade when
    // the value settles back to what is already on screen.
    if (reducedMotion || !animatedApi?.timing || Object.is(pair.from, pair.to)) {
      progress.setValue(1);
      return;
    }

    progress.setValue(0);
    animatedApi.timing(progress, {
      toValue: 1,
      duration: appTheme.motion?.duration.state ?? 180,
      useNativeDriver: true,
    }).start();
  }, [pair, progress, reducedMotion]);

  return { from: pair.from, to: pair.to, progress };
}

/**
 * Timing for a full-screen overlay entering and leaving. Entrances use a
 * strong ease-out so the surface reads as immediate; exits are shorter so
 * dismissal never lingers. Reduced motion collapses both to an instant cut.
 */
export function getOverlayPresenceSpec(reducedMotion: boolean) {
  return reducedMotion
    ? { enterDurationMs: 0, exitDurationMs: 0, enterScaleFrom: 1 }
    : { enterDurationMs: 320, exitDurationMs: 220, enterScaleFrom: 0.97 };
}

const overlayEnterEasing = optionalNativeExport(() => Easing.bezier(0.23, 1, 0.32, 1));
const overlayExitEasing = optionalNativeExport(() => Easing.in(Easing.quad));

/**
 * Mount-and-fade presence for a full-screen overlay: fades and settles from a
 * slight scale on open, and keeps the subtree mounted just long enough to fade
 * back out on close — an overlay that appears or vanishes in a single frame
 * reads as broken rather than fast. Reduced motion (and the minimal
 * react-native mocks tests use) snap between states instantly.
 */
export function useOverlayPresence(visible: boolean) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState<Animated.Value | null>(() => createValue(visible ? 1 : 0));

  useEffect(() => {
    if (visible) setMounted(true);

    if (!progress || reducedMotion || !animatedApi?.timing) {
      progress?.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }

    const spec = getOverlayPresenceSpec(reducedMotion);
    progress.stopAnimation();
    animatedApi.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? spec.enterDurationMs : spec.exitDurationMs,
      easing: (visible ? overlayEnterEasing : overlayExitEasing) ?? undefined,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!visible && finished) setMounted(false);
    });
  }, [progress, reducedMotion, visible]);

  return {
    mounted,
    animatedStyle: progress
      ? ({
          opacity: progress,
          transform: [{
            scale: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [getOverlayPresenceSpec(false).enterScaleFrom, 1],
            }),
          }],
        } as Animated.WithAnimatedValue<ViewStyle>)
      : undefined,
  };
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
