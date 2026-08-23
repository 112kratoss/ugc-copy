import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { getContainedRect, type ViewerOrigin } from '@/lib/viewer-transition';

/**
 * Continuity for the immersive viewer.
 *
 * Opening: when a tile handed over its rectangle, a hero copy of the tile's
 * image grows from that rectangle to where the viewer draws the media while a
 * black backdrop fades up underneath; the real slide fades in beneath the hero
 * in the second half, then the hero lets go. Without an origin (deep links,
 * reduced motion) the viewer simply fades in.
 *
 * Closing: on the first page a downward drag carries the whole viewer with
 * the finger — it shrinks and rounds off while the backdrop thins so the
 * screen underneath shows through — and a committed drag collapses it back
 * into the tile it came from. The back button and the system back gesture
 * run the same collapse.
 */
const OPEN_SPRING = { damping: 26, stiffness: 240, mass: 1 };
const PLAIN_OPEN_MS = 180;
// Mounting the viewer freezes the UI thread for a moment; a spring started
// at mount spends its first frames inside that freeze. So the flight waits
// for the hero image to actually paint, with a ceiling so it always starts.
const HERO_PAINT_FALLBACK_MS = 400;
// The viewer's real content (pager, rail, caption) is heavy enough to freeze
// the UI thread for a moment when it mounts. Mounting it only after the hero
// has landed keeps that freeze out of the flight; it fades in under the
// settled hero instead. This is the ceiling on how long content can wait.
const CONTENT_MOUNT_FALLBACK_MS = 1200;
const CONTENT_FADE_MS = 160;
const HERO_HOLD_MS = 240;
const HERO_FADE_MS = 200;
const COLLAPSE_MS = 260;
const DISMISS_SAFETY_MS = COLLAPSE_MS + 160;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;
const DRAG_TRAVEL = 360;
const DRAG_MIN_SCALE = 0.72;
const DRAG_RADIUS = 28;
const ACTIVATE_DISTANCE = 18;

type CollapseTarget = { x: number; y: number; scale: number } | null;

export interface ViewerTransitionOptions {
  origin: ViewerOrigin | null;
  width: number;
  height: number;
  reducedMotion: boolean;
  /** Aspect ratio of the media drawn first, so the hero lands exactly on it. */
  targetAspectRatio: number | null;
  /** Only the first page is free in the downward direction; elsewhere it pages. */
  dismissEnabled: boolean;
  /** True while the origin item is the one on screen, so a collapse can return to its tile. */
  shouldCollapseToOrigin: () => boolean;
  onDismissed: () => void;
}

export function useViewerTransition(options: ViewerTransitionOptions) {
  const { origin, width, height, reducedMotion, targetAspectRatio, dismissEnabled } = options;
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  const dragY = useSharedValue(0);
  const heroOpacity = useSharedValue(1);
  const collapseTarget = useSharedValue<CollapseTarget>(null);
  const [heroVisible, setHeroVisible] = useState(Boolean(origin?.previewUrl) && !reducedMotion);
  const [contentReady, setContentReady] = useState(!origin || reducedMotion);
  const [heroAspectRatio, setHeroAspectRatio] = useState<number | null>(null);
  const contentOpacity = useSharedValue(origin && !reducedMotion ? 0 : 1);
  const dismissingRef = useRef(false);
  const allowRemoveRef = useRef(false);
  const openStartedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // The hero's own decoded size is the truth about where the viewer will
  // draw the picture; the caller's ratio (API metadata) is only the fallback
  // for the frames before the hero has loaded.
  const targetRect = useMemo(
    () => getContainedRect({ width, height }, heroAspectRatio ?? targetAspectRatio),
    [height, heroAspectRatio, targetAspectRatio, width],
  );

  const revealContent = useCallback(() => {
    setContentReady(true);
    contentOpacity.value = withTiming(1, { duration: CONTENT_FADE_MS });
  }, [contentOpacity]);

  const onHeroLoad = useCallback((imageWidth: number, imageHeight: number) => {
    if (imageWidth > 0 && imageHeight > 0) setHeroAspectRatio(imageWidth / imageHeight);
  }, []);

  const startOpen = useCallback(() => {
    if (openStartedRef.current) return;
    openStartedRef.current = true;
    progress.value = withSpring(1, OPEN_SPRING, (finished) => {
      if (!finished) return;
      runOnJS(revealContent)();
      heroOpacity.value = withDelay(
        HERO_HOLD_MS,
        withTiming(0, { duration: HERO_FADE_MS }, (done) => {
          if (done) runOnJS(setHeroVisible)(false);
        }),
      );
    });
  }, [heroOpacity, progress, revealContent]);

  useEffect(() => {
    if (reducedMotion) {
      progress.value = 1;
      return undefined;
    }
    if (!origin) {
      progress.value = withTiming(1, { duration: PLAIN_OPEN_MS, easing: Easing.out(Easing.quad) });
      return undefined;
    }
    if (!origin.previewUrl) {
      startOpen();
      return undefined;
    }
    // Normal path: the hero's onDisplay starts the flight and its landing
    // mounts the content. These are the ceilings.
    const fallback = setTimeout(startOpen, HERO_PAINT_FALLBACK_MS);
    const contentFallback = setTimeout(revealContent, CONTENT_MOUNT_FALLBACK_MS);
    return () => {
      clearTimeout(fallback);
      clearTimeout(contentFallback);
    };
    // Mount-only: the open animation plays once, whatever props do afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishDismiss = useCallback(() => {
    if (allowRemoveRef.current) return;
    allowRemoveRef.current = true;
    optionsRef.current.onDismissed();
  }, []);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    const current = optionsRef.current;
    if (current.reducedMotion) {
      finishDismiss();
      return;
    }

    const toOrigin = current.origin && current.shouldCollapseToOrigin() ? current.origin : null;
    collapseTarget.value = toOrigin
      ? {
        x: toOrigin.rect.x + toOrigin.rect.width / 2 - current.width / 2,
        y: toOrigin.rect.y + toOrigin.rect.height / 2 - current.height / 2,
        scale: Math.max(0.12, toOrigin.rect.width / current.width),
      }
      : { x: 0, y: current.height * 0.55, scale: 0.6 };
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: COLLAPSE_MS, easing: Easing.in(Easing.quad) }, (finished) => {
      if (finished) runOnJS(finishDismiss)();
    });
    // The animation callback is the normal path; this only catches an
    // interrupted animation so the viewer can never be stuck half-closed.
    setTimeout(finishDismiss, DISMISS_SAFETY_MS);
  }, [collapseTarget, finishDismiss, progress]);

  // The vertical pager is a native scroll view. Left alone, its first move
  // asks the gesture root to disallow interception, which cancels every other
  // handler — the pan would begin and immediately fail. Registering the list
  // as a native gesture and running the pan alongside it lets both see the
  // drag: at the top the list has nowhere to go, and the pan carries the view.
  const listGesture = useMemo(() => Gesture.Native(), []);
  const gesture = useMemo(() => Gesture.Pan()
    .simultaneousWithExternalGesture(listGesture)
    .enabled(dismissEnabled && !reducedMotion)
    .activeOffsetY(ACTIVATE_DISTANCE)
    .failOffsetY(-10)
    .failOffsetX([-14, 14])
    .onUpdate((event) => {
      dragY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (dragY.value > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        runOnJS(dismiss)();
        return;
      }
      dragY.value = withSpring(0, { damping: 22, stiffness: 260 });
    })
    .onFinalize((_event, success) => {
      if (!success) dragY.value = withSpring(0, { damping: 22, stiffness: 260 });
    }), [dismiss, dismissEnabled, dragY, listGesture, reducedMotion]);

  const backdropStyle = useAnimatedStyle(() => {
    const drag = Math.min(1, dragY.value / DRAG_TRAVEL);
    return { opacity: progress.value * (1 - drag * 0.9) };
  });

  const containerStyle = useAnimatedStyle(() => {
    const drag = Math.min(1, dragY.value / DRAG_TRAVEL);
    const collapse = 1 - progress.value;
    const target = collapseTarget.value;
    const dragScale = 1 - (1 - DRAG_MIN_SCALE) * drag;
    const collapseScale = target ? 1 - (1 - target.scale) * collapse : 1;
    const openScale = origin ? 1 : 0.96 + 0.04 * progress.value;
    const opacity = target
      ? interpolate(progress.value, [0, 0.45], [0, 1], Extrapolation.CLAMP)
      : origin
        ? interpolate(progress.value, [0.55, 1], [0, 1], Extrapolation.CLAMP)
        : progress.value;

    return {
      opacity: opacity * contentOpacity.value,
      borderRadius: DRAG_RADIUS * Math.max(drag, target ? collapse : 0),
      transform: [
        { translateX: target ? target.x * collapse : 0 },
        { translateY: dragY.value * 0.92 + (target ? target.y * collapse : 0) },
        { scale: dragScale * collapseScale * openScale },
      ],
    };
  }, [origin]);

  const heroStyle = useAnimatedStyle(() => {
    if (!origin) return { opacity: 0 };
    const value = progress.value;
    const from = origin.rect;
    return {
      left: interpolate(value, [0, 1], [from.x, targetRect.x]),
      top: interpolate(value, [0, 1], [from.y, targetRect.y]),
      width: interpolate(value, [0, 1], [from.width, targetRect.width]),
      height: interpolate(value, [0, 1], [from.height, targetRect.height]),
      borderRadius: origin.radius * (1 - value),
      opacity: heroOpacity.value,
    };
  }, [origin, targetRect]);

  return {
    origin,
    heroVisible,
    contentReady,
    gesture,
    listGesture,
    backdropStyle,
    containerStyle,
    heroStyle,
    dismiss,
    startOpen,
    onHeroLoad,
    allowRemoveRef,
  };
}

export type ViewerTransition = ReturnType<typeof useViewerTransition>;

export function ViewerTransitionBackdrop({ transition }: { transition: ViewerTransition }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, transition.backdropStyle]}
    />
  );
}

export function ViewerTransitionContainer({
  transition,
  children,
}: {
  transition: ViewerTransition;
  children: ReactNode;
}) {
  return (
    <GestureDetector gesture={transition.gesture}>
      <Animated.View style={[{ flex: 1, overflow: 'hidden' }, transition.containerStyle]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export function ViewerHeroOverlay({ transition }: { transition: ViewerTransition }) {
  const { origin, heroVisible } = transition;
  if (!heroVisible || !origin?.previewUrl) return null;

  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', overflow: 'hidden' }, transition.heroStyle]}>
      <Image
        source={{ uri: origin.previewUrl, cacheKey: origin.cacheKey ?? undefined }}
        placeholder={origin.thumbhash ? { thumbhash: origin.thumbhash } : undefined}
        contentFit="cover"
        cachePolicy="memory-disk"
        priority="high"
        // The hero grows every frame; with downscaling on, Android re-decodes
        // the image for each new size and the flight is mostly blank.
        allowDownscaling={false}
        onLoad={(event) => transition.onHeroLoad(event.source.width, event.source.height)}
        onDisplay={transition.startOpen}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}
