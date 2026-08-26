import { createContext, useContext, useId, useLayoutEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

/**
 * A place to render full-screen surfaces inside the app's own window.
 *
 * React Native's `Modal` is a separate window on Android, and that window
 * receives neither the keyboard insets Reanimated reads nor the JS `Keyboard`
 * events — both were measured returning nothing from inside one. A sheet with a
 * text field hosted there cannot lift, so the composer sits under the keyboard
 * while you type into it.
 *
 * Rendering above the navigator instead keeps such a surface in the same window
 * as everything else, so ordinary keyboard avoidance applies. It also draws over
 * the tab bar, which an overlay mounted inside a tab screen cannot do.
 */
type OverlayApi = {
  present: (id: string, node: React.ReactNode) => void;
  dismiss: (id: string) => void;
};

const OverlayContext = createContext<OverlayApi | null>(null);

type Layer = { id: string; node: React.ReactNode };

export function OverlayHost({ children }: { children: React.ReactNode }) {
  const [layers, setLayers] = useState<Layer[]>([]);

  const api = useMemo<OverlayApi>(() => ({
    present(id, node) {
      setLayers((current) => {
        const index = current.findIndex((layer) => layer.id === id);
        if (index === -1) return [...current, { id, node }];
        const next = current.slice();
        next[index] = { id, node };
        return next;
      });
    },
    dismiss(id) {
      setLayers((current) => (
        current.some((layer) => layer.id === id)
          ? current.filter((layer) => layer.id !== id)
          : current
      ));
    },
  }), []);

  return (
    <OverlayContext.Provider value={api}>
      {children}
      {layers.map((layer) => (
        // `box-none` so the layer itself never eats touches — only what the
        // surface actually draws does.
        <View key={layer.id} pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
          {layer.node}
        </View>
      ))}
    </OverlayContext.Provider>
  );
}

/**
 * Renders `children` at the root while `visible`.
 *
 * Without a host in the tree — focused component tests mount a screen on its
 * own — it renders in place instead, so a suite can still find the surface it
 * is asserting on.
 */
export function Overlay({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  const id = useId();
  const api = useContext(OverlayContext);

  // Deliberately no dependency array: the owner re-renders on every keystroke
  // in the composer, and the hosted copy has to follow it. `useLayoutEffect`
  // rather than `useEffect` so the host re-renders in the same commit and
  // typing never trails a frame behind.
  useLayoutEffect(() => {
    if (!api) return;
    if (visible) api.present(id, children);
    else api.dismiss(id);
  });

  useLayoutEffect(() => () => api?.dismiss(id), [api, id]);

  if (!api) return visible ? <>{children}</> : null;

  return null;
}
