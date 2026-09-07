import { createContext, useMemo, useRef } from 'react';
import { Dimensions, ScrollView, type ScrollViewProps } from 'react-native';

export type MediaViewportRect = { x: number; y: number; width: number; height: number };
export type MediaViewport = {
  subscribe: (listener: () => void) => () => void;
  measure: (receive: (rect: MediaViewportRect) => void) => void;
};
export const MediaViewportContext = createContext<MediaViewport | null>(null);

/** Scroll events drive preview checks; no per-player polling or scroll state renders. */
export function MediaViewportScrollView(props: ScrollViewProps) {
  const ref = useRef<ScrollView>(null);
  const listeners = useRef(new Set<() => void>());
  const viewport = useMemo<MediaViewport>(() => ({
    subscribe(listener) { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    measure(receive) {
      ref.current?.getNativeScrollRef()?.measureInWindow((x, y, width, height) => {
        const window = Dimensions.get('window');
        const left = Math.max(0, x), top = Math.max(0, y);
        receive({ x: left, y: top, width: Math.max(0, Math.min(window.width, x + width) - left), height: Math.max(0, Math.min(window.height, y + height) - top) });
      });
    },
  }), []);
  const notify = () => { for (const listener of listeners.current) listener(); };
  return (
    <MediaViewportContext.Provider value={viewport}>
      <ScrollView
        {...props}
        ref={ref}
        scrollEventThrottle={100}
        onScroll={(event) => { props.onScroll?.(event); notify(); }}
        onLayout={(event) => { props.onLayout?.(event); notify(); }}
        onContentSizeChange={(width, height) => { props.onContentSizeChange?.(width, height); notify(); }}
      />
    </MediaViewportContext.Provider>
  );
}
