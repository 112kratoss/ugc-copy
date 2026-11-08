// The wall of creations behind the sign-in screen (owner, 2026-11-08: "medias in the
// background in a loop"): twelve community posts, shipped inside the app so the wall is
// never blank on a slow network, in four tilted columns that drift past each other.
// Each column is its tiles twice over, slid by exactly one set's height and started again,
// so the loop has no seam. The slides run on the native driver; Reduce Motion holds them.
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

import wall01 from '../assets/images/sign-in-wall/wall-01.jpg';
import wall02 from '../assets/images/sign-in-wall/wall-02.jpg';
import wall03 from '../assets/images/sign-in-wall/wall-03.jpg';
import wall04 from '../assets/images/sign-in-wall/wall-04.jpg';
import wall05 from '../assets/images/sign-in-wall/wall-05.jpg';
import wall06 from '../assets/images/sign-in-wall/wall-06.jpg';
import wall07 from '../assets/images/sign-in-wall/wall-07.jpg';
import wall08 from '../assets/images/sign-in-wall/wall-08.jpg';
import wall09 from '../assets/images/sign-in-wall/wall-09.jpg';
import wall10 from '../assets/images/sign-in-wall/wall-10.jpg';
import wall11 from '../assets/images/sign-in-wall/wall-11.jpg';
import wall12 from '../assets/images/sign-in-wall/wall-12.jpg';

/** Picked from the top public posts on 2026-11-08; the record names each one's post. */
export const MEDIA_WALL_TILES = [
  wall01, wall02, wall03, wall04, wall05, wall06, wall07, wall08, wall09, wall10, wall11, wall12,
] as const;

const COLUMNS = 4;
/** Each column's set: six of the twelve, so a picture never meets itself on screen. */
const PER_COLUMN = 6;
const GAP = 10;
/** Wider than the screen, so the tilt never shows a corner. */
const WALL_SCALE = 1.5;
const TILT = '-10deg';
/** Points a second: slow enough to read as a backdrop, not a feed. */
const DRIFT_SPEED = 14;

export type MediaWallGeometry = {
  wallWidth: number;
  tileWidth: number;
  tileHeight: number;
  /** One set of a column's tiles, gaps included: the distance a loop slides. */
  cycle: number;
  /** Where the doubled columns start, so either end of a slide still covers the screen. */
  top: number;
};

export function mediaWallGeometry(width: number, height: number): MediaWallGeometry {
  const wallWidth = width * WALL_SCALE;
  const tileWidth = (wallWidth - GAP * (COLUMNS - 1)) / COLUMNS;
  const tileHeight = Math.round((tileWidth * 16) / 9);
  const cycle = PER_COLUMN * (tileHeight + GAP);
  // A column spans [top + o, top + o + 2·cycle] with o anywhere in [-cycle, 0]. Centring the
  // screen's height inside one cycle leaves the same margin above and below at both ends.
  return { wallWidth, tileWidth, tileHeight, cycle, top: Math.round((height - cycle) / 2) };
}

/**
 * Column c takes every fourth picture from c, then every fourth from c + 2: neighbouring
 * columns never share one, and the two that do (0 and 2, 1 and 3) start apart.
 */
export function mediaWallColumn(column: number) {
  const count = MEDIA_WALL_TILES.length;
  const order = [0, 4, 8, 2, 6, 10].map((step) => (column + step) % count);
  return order.map((index) => MEDIA_WALL_TILES[index]);
}

export function MediaWall({ width, height }: { width: number; height: number }) {
  const geometry = mediaWallGeometry(width, height);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    >
      <View
        style={{
          position: 'absolute',
          left: (width - geometry.wallWidth) / 2,
          top: geometry.top,
          width: geometry.wallWidth,
          height: geometry.cycle * 2,
          flexDirection: 'row',
          gap: GAP,
          transform: [{ rotate: TILT }],
        }}
      >
        {Array.from({ length: COLUMNS }, (_, column) => (
          <WallColumn
            key={column}
            tiles={mediaWallColumn(column)}
            geometry={geometry}
            // Neighbours drift opposite ways, and each at its own pace, so rows never line up.
            upward={column % 2 === 0}
            speed={DRIFT_SPEED * (column % 2 === 0 ? 1 : 0.8) * (column < 2 ? 1 : 1.15)}
          />
        ))}
      </View>
    </View>
  );
}

function WallColumn({ tiles, geometry, upward, speed }: {
  tiles: readonly number[];
  geometry: MediaWallGeometry;
  upward: boolean;
  speed: number;
}) {
  const reducedMotion = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const duration = Math.round((geometry.cycle / speed) * 1000);

  useEffect(() => {
    if (reducedMotion) return;
    const drift = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    drift.start();
    return () => drift.stop();
  }, [duration, progress, reducedMotion]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: upward ? [0, -geometry.cycle] : [-geometry.cycle, 0],
  });

  return (
    <Animated.View style={{ width: geometry.tileWidth, gap: GAP, transform: [{ translateY }] }}>
      {[...tiles, ...tiles].map((tile, index) => (
        <View
          key={index}
          style={{
            width: geometry.tileWidth,
            height: geometry.tileHeight,
            borderRadius: appTheme.radii.md,
            borderCurve: 'continuous',
            overflow: 'hidden',
          }}
        >
          <Image source={tile} contentFit="cover" transition={0} style={{ width: '100%', height: '100%' }} />
        </View>
      ))}
    </Animated.View>
  );
}
