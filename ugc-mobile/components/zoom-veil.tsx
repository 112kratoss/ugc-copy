import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import { mediaColors } from '@/lib/theme';
import { zoomVeil, zoomVeilHole } from '@/lib/zoom-veil';

/**
 * The black a screen is covered in while a reel grows out of one of its tiles
 * or shrinks back into it under UIKit's zoom (lib/zoom-veil.ts). Drawn last on
 * the screen, over its tab bar too, and never touched; nothing at all where
 * the zoom does not run. Four pieces rather than one, so the tapped tile can
 * be left clear until the transition takes its picture over.
 */
export function ZoomVeil() {
  const { width, height } = useWindowDimensions();
  const above = useAnimatedStyle(() => {
    const hole = zoomVeilHole.value;
    return { opacity: zoomVeil.value, left: 0, top: 0, width, height: hole ? Math.max(0, hole.y) : height };
  });
  const below = useAnimatedStyle(() => {
    const hole = zoomVeilHole.value;
    const top = hole ? hole.y + hole.height : height;
    return { opacity: zoomVeil.value, left: 0, top, width, height: Math.max(0, height - top) };
  });
  const left = useAnimatedStyle(() => {
    const hole = zoomVeilHole.value;
    return { opacity: zoomVeil.value, left: 0, top: hole ? hole.y : 0, width: hole ? Math.max(0, hole.x) : 0, height: hole ? hole.height : 0 };
  });
  const right = useAnimatedStyle(() => {
    const hole = zoomVeilHole.value;
    const start = hole ? hole.x + hole.width : width;
    return { opacity: zoomVeil.value, left: start, top: hole ? hole.y : 0, width: hole ? Math.max(0, width - start) : 0, height: hole ? hole.height : 0 };
  });
  if (!isAppleZoomAvailable()) return null;
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.piece, above]} />
      <Animated.View pointerEvents="none" style={[styles.piece, below]} />
      <Animated.View pointerEvents="none" style={[styles.piece, left]} />
      <Animated.View pointerEvents="none" style={[styles.piece, right]} />
    </>
  );
}

const styles = StyleSheet.create({
  piece: { position: 'absolute', backgroundColor: mediaColors.mediaGround, zIndex: 1000 },
});
