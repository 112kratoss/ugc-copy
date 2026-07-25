import { useEffect, useRef } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';

const DEFAULT_DOUBLE_TAP_DELAY_MS = 280;

type DoubleTapPressableProps = Omit<PressableProps, 'onPress'> & {
  doubleTapDelayMs?: number;
  onDoublePress: (event: GestureResponderEvent) => void;
  onSinglePress?: () => void;
};

export function DoubleTapPressable({
  doubleTapDelayMs = DEFAULT_DOUBLE_TAP_DELAY_MS,
  onDoublePress,
  onSinglePress,
  ...props
}: DoubleTapPressableProps) {
  const lastTapAtRef = useRef(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
  }, []);

  const handlePress = (event: GestureResponderEvent) => {
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

  return <Pressable {...props} onPress={handlePress} />;
}
