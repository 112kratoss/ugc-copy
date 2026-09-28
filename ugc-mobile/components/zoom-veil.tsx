import { useSyncExternalStore } from 'react';
import { Animated as NativeAnimated, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedProps } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import { mediaColors } from '@/lib/theme';
import { zoomVeil, zoomVeilHole } from '@/lib/zoom-veil';
import { getNativeZoomVeilOpacity, subscribeToNativeZoomVeil } from '@/lib/native-zoom-veil';

/**
 * The black a screen is covered in while a reel grows out of one of its tiles
 * or shrinks back into it under UIKit's zoom (lib/zoom-veil.ts). Drawn last on
 * the screen, over its tab bar too, and never touched; nothing at all where
 * the zoom does not run. A rounded cutout leaves the tapped tile clear until
 * the transition takes its picture over, without exposing the light grid at
 * its corners.
 */
const AnimatedPath = Animated.createAnimatedComponent(Path);

export function ZoomVeil() {
  const nativeOpacity = useSyncExternalStore(subscribeToNativeZoomVeil, getNativeZoomVeilOpacity);
  const { width, height } = useWindowDimensions();
  const veilProps = useAnimatedProps(() => {
    const hole = zoomVeilHole.value;
    let d = `M0 0H${width}V${height}H0Z`;
    if (hole) {
      const { x, y, width: w, height: h } = hole;
      const r = Math.max(0, Math.min(hole.radius ?? 0, w / 2, h / 2));
      d += `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
    }
    return { d, opacity: zoomVeil.value };
  });
  if (!isAppleZoomAvailable()) return null;
  return (
    <NativeAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 1000, opacity: nativeOpacity ?? 1 }]}>
      <Svg width={width} height={height}>
        <AnimatedPath animatedProps={veilProps} fill={mediaColors.mediaGround} fillRule="evenodd" />
      </Svg>
    </NativeAnimated.View>
  );
}
