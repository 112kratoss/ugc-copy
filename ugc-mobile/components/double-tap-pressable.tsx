import { useEffect, useRef } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';

const DEFAULT_DOUBLE_TAP_DELAY_MS = 280;

/**
 * How far a finger may travel between going down and coming up and still be a
 * tap. `Pressable` fires `onPress` wherever the finger lifts inside the view,
 * however far it moved on the way, so on a pressable the size of the screen a
 * swipe read as a tap. iOS's zoom transition delivers the touches of its
 * dismissal gestures — the back swipe, the drag down, the pinch — to the reel
 * as well as taking them itself, and the reel's single-tap action paused its
 * video 280 ms after every gesture close (measured 2026-09-27: the tile then
 * showed a frozen picture for ~0.9 s until the close had ended). UIKit's own
 * tap recogniser fails once a touch moves; this is the same rule.
 */
export const TAP_SLOP_PT = 12;

type DoubleTapPressableProps = Omit<PressableProps, 'onPress'> & {
  doubleTapDelayMs?: number;
  onDoublePress: (event: GestureResponderEvent) => void;
  onSinglePress?: () => void;
};

function pointOf(event: GestureResponderEvent | undefined) {
  const native = event?.nativeEvent;
  return native && typeof native.pageX === 'number' && typeof native.pageY === 'number'
    ? { x: native.pageX, y: native.pageY }
    : null;
}

export function DoubleTapPressable({
  doubleTapDelayMs = DEFAULT_DOUBLE_TAP_DELAY_MS,
  onDoublePress,
  onSinglePress,
  onPressIn,
  ...props
}: DoubleTapPressableProps) {
  const lastTapAtRef = useRef(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchDownRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cancelPendingTap = () => {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
      lastTapAtRef.current = 0;
    };
    // A single tap waits for the double-tap window. Do not replay that action
    // after the app loses focus (for example Pause immediately followed by Home).
    const change = AppState.addEventListener('change', state => {
      if (state !== 'active') cancelPendingTap();
    });
    const blur = Platform.OS === 'android'
      ? AppState.addEventListener('blur', cancelPendingTap)
      : null;
    return () => { cancelPendingTap(); change.remove(); blur?.remove(); };
  }, []);

  const handlePressIn = (event: GestureResponderEvent) => {
    touchDownRef.current = pointOf(event);
    onPressIn?.(event);
  };

  const handlePress = (event: GestureResponderEvent) => {
    const down = touchDownRef.current;
    touchDownRef.current = null;
    const up = pointOf(event);
    if (down && up && Math.hypot(up.x - down.x, up.y - down.y) > TAP_SLOP_PT) {
      // A swipe, not a tap: it does nothing, and does not pair with a tap before it.
      lastTapAtRef.current = 0;
      return;
    }

    const now = Date.now();
    const isDoublePress = lastTapAtRef.current > 0
      && now - lastTapAtRef.current <= doubleTapDelayMs;

    if (isDoublePress) {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
      lastTapAtRef.current = 0;
      onDoublePress(event);
      return;
    }

    lastTapAtRef.current = now;
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
    singleTapTimerRef.current = setTimeout(() => {
      lastTapAtRef.current = 0;
      singleTapTimerRef.current = null;
      onSinglePress?.();
    }, doubleTapDelayMs);
  };

  return <Pressable {...props} onPressIn={handlePressIn} onPress={handlePress} />;
}
