import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

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
