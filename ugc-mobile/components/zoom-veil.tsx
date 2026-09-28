import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Animated as NativeAnimated, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import { mediaColors } from '@/lib/theme';
import {
  createScreenVeil,
  getZoomVeilOpacity,
  registerScreenVeil,
  subscribeToZoomVeilOpacity,
  ZoomVeilOwnerContext,
  type ScreenVeil,
} from '@/lib/zoom-veil';

/**
 * A screen a reel can grow out of (lib/zoom-veil.ts): names it for the tiles
 * inside, whose taps drop the veil on it, and draws its veil last, over
 * everything else on it — its tab bar or its top bar too.
 */
export function ZoomVeilScope({ children }: { children: ReactNode }) {
  const owner = useId();
  const [veil] = useState(createScreenVeil);
  useEffect(() => registerScreenVeil(owner, veil), [owner, veil]);
  return (
    <ZoomVeilOwnerContext.Provider value={owner}>
      {children}
      <ZoomVeil owner={owner} veil={veil} />
    </ZoomVeilOwnerContext.Provider>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The black `owner`'s screen is covered in while a reel grows out of one of its
 * tiles or shrinks back into it under UIKit's zoom. Never touched, and nothing
 * at all where the zoom does not run. A rounded cutout leaves the tapped tile
 * clear until the transition takes its picture over, without exposing the
 * light grid at its corners.
 */
function ZoomVeil({ owner, veil }: { owner: string; veil: ScreenVeil }) {
  const subscribe = useCallback((listener: () => void) => subscribeToZoomVeilOpacity(owner, listener), [owner]);
  const transition = useSyncExternalStore(subscribe, () => getZoomVeilOpacity(owner));
  const { width, height } = useWindowDimensions();
  const { cover, hole } = veil;
  const veilProps = useAnimatedProps(() => {
    const tile = hole.value;
    let d = `M0 0H${width}V${height}H0Z`;
    if (tile) {
      const { x, y, width: w, height: h } = tile;
      const r = Math.max(0, Math.min(tile.radius ?? 0, w / 2, h / 2));
      d += `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
    }
    return { d, opacity: cover.value };
  });
  if (!isAppleZoomAvailable()) return null;
  return (
    <NativeAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 1000, opacity: transition ?? 1 }]}>
      <Svg width={width} height={height}>
        <AnimatedPath animatedProps={veilProps} fill={mediaColors.mediaGround} fillRule="evenodd" />
      </Svg>
    </NativeAnimated.View>
  );
}
