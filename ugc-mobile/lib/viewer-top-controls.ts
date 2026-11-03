import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * Whether the reel's Back and sound controls show (components/viewer-top-control.tsx).
 * Out of a tile by UIKit's zoom they come in once it has crossfaded to the reel
 * and go as a close begins (`AppleZoomTopControlsCue`); anywhere else they are
 * there from the start.
 *
 * Held apart from the reel's own state, and read by the controls alone: the
 * answer changes mid-zoom, and as a prop of the reel's screen it drew the whole
 * reel again then — its list, its slides' props and its sheets — when only the
 * two controls had anything to change.
 */
export interface ViewerTopControls {
  isShown: () => boolean;
  setShown: (shown: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createViewerTopControls(shown: boolean): ViewerTopControls {
  let current = shown;
  const listeners = new Set<() => void>();
  return {
    isShown: () => current,
    setShown: (next) => {
      if (next === current) return;
      current = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Controls drawn outside a reel's screen have nothing to wait for. */
export const ViewerTopControlsContext = createContext<ViewerTopControls>(createViewerTopControls(true));

export function useViewerTopControlsShown() {
  const controls = useContext(ViewerTopControlsContext);
  return useSyncExternalStore(controls.subscribe, controls.isShown, controls.isShown);
}
