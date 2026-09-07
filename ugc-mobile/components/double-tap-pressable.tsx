import { useEffect, useRef } from 'react';
import {
  AppState,
  Platform,
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
