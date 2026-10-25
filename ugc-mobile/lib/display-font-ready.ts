import { useSyncExternalStore } from 'react';

/**
 * Whether the display face (`DISPLAY_FONT` in `theme.ts`) has loaded. The root
 * layout loads it with `useFonts`, which starts only after the app's first
 * render, so text that render draws in the face is drawn in the system face
 * instead, and on Android it stays that way until the text is drawn again.
 * Text that is on screen from launch and is rarely drawn again (Home's shelf
 * title) keys itself on this, so it is drawn anew once the face is in.
 */

let loaded = false;
const listeners = new Set<() => void>();

/** Called by the root layout once `useFonts` reports the faces loaded. */
export function markDisplayFontLoaded() {
  if (loaded) return;
  loaded = true;
  for (const listener of listeners) listener();
}

export function isDisplayFontLoaded() {
  return loaded;
}

export function subscribeDisplayFontLoaded(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDisplayFontLoaded(): boolean {
  return useSyncExternalStore(subscribeDisplayFontLoaded, isDisplayFontLoaded, isDisplayFontLoaded);
}
