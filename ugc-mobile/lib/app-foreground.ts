import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { useInModalWindow } from '@/lib/modal-window';

/** Unknown counts as foreground: `currentState` can be null before the first report. */
export function isAppForeground() {
  const state = AppState.currentState;
  return !state || state === 'active';
}

/**
 * Calls back when the app moves between the foreground and the background, for
 * deadlines and refreshes that must not run while nobody can see the screen.
 * Returns the unsubscribe.
 */
export function subscribeToAppForeground(onChange: (foreground: boolean) => void) {
  let last = isAppForeground();
  const subscription = AppState.addEventListener('change', (state) => {
    const next = state === 'active';
    if (next === last) return;
    last = next;
    onChange(next);
  });
  return () => subscription.remove();
}

/**
 * Whether what this component draws can be seen: the app active and, on
 * Android, the activity's window holding the focus (a Modal or the
 * notification shade over it takes it). Inside a Modal's own window
 * (`ModalWindowScope`) that window's focus is not reported, so only the app's
 * state counts there. Unlike `isAppForeground`, unknown counts as not in view:
 * a countdown that must run only while it can be read waits for the first
 * report. Followed for as long as the component is mounted, since a Modal can
 * already hold the focus when a countdown starts.
 */
export function useWindowInView() {
  const inModalWindow = useInModalWindow();
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  const [windowFocused, setWindowFocused] = useState(true);
  useEffect(() => {
    const change = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    const followsFocus = Platform.OS === 'android' && !inModalWindow;
    const blur = followsFocus ? AppState.addEventListener('blur', () => setWindowFocused(false)) : null;
    const focus = followsFocus ? AppState.addEventListener('focus', () => setWindowFocused(true)) : null;
    return () => {
      change.remove();
      blur?.remove();
      focus?.remove();
    };
  }, [inModalWindow]);
  return appActive && (Platform.OS !== 'android' || inModalWindow || windowFocused);
}

/**
 * Whether the app is in the foreground, tracked only while `enabled`: a surface
 * that has no deadline running does not subscribe at all.
 */
export function useAppForeground(enabled = true) {
  const [foreground, setForeground] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    setForeground(isAppForeground());
    return subscribeToAppForeground(setForeground);
  }, [enabled]);

  return foreground;
}
