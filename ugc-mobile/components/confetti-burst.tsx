import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * A burst with some volume that pops up out of the Claim button and falls
 * back over the card (owner, 2026-11-09): a few dozen pieces, under two seconds.
 */
const PIECE_COUNT = 56;
const BURST_MS = 1700;

type Piece = {
  dx: number;
  rise: number;
  fall: number;
  spin: number;
  width: number;
  height: number;
  delay: number;
  colorIndex: number;
};

/** Seeded so a burst is the same every time it plays (and in tests). */
export function confettiPieces(count = PIECE_COUNT, seed = 7): Piece[] {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
  return Array.from({ length: count }, (_, index) => {
    const round = index % 3 === 0;
    const size = 6 + Math.round(next() * 4);
    return {
      dx: (next() - 0.5) * 380,
      rise: 220 + next() * 260,
      fall: 320 + next() * 220,
      spin: (next() - 0.5) * 900,
      width: size,
      height: round ? size : size + 5,
      delay: Math.round(next() * 140),
      colorIndex: index,
    };
  });
}

/**
 * Plays once when `play` turns true. Pieces start at `origin` (a point in the
 * parent, which should fill the screen), shoot up and out, then fall and fade.
 * Native-driven transforms and opacity only; nothing under Reduce Motion. Not
 * touchable.
 */
export function ConfettiBurst({ play, origin }: { play: boolean; origin: { x: number; y: number } | null }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [pieces] = useState(() => confettiPieces());
  const [progress] = useState(() => pieces.map(() => new Animated.Value(0, { useNativeDriver: true })));
  const palette = [
    theme.colors.primaryFill,
    theme.colors.navigationCreateTop,
    theme.colors.warning,
    theme.colors.success,
    theme.colors.info,
    theme.colors.motion,
  ];

  useEffect(() => {
    if (!play || reducedMotion) return;
    const animations = progress.map((value, index) => {
      value.setValue(0);
      return Animated.timing(value, {
        toValue: 1,
        duration: BURST_MS,
        delay: pieces[index].delay,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
    });
    const burst = Animated.parallel(animations);
    burst.start();
    return () => burst.stop();
  }, [play, pieces, progress, reducedMotion]);

  if (!play || reducedMotion || !origin) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', inset: 0 }}
    >
      {pieces.map((piece, index) => {
        const value = progress[index];
        return (
          <Animated.View
            key={index}
            style={{
              // Round pieces are dots; the rest are square-cornered strips.
              ...(piece.width === piece.height ? { borderRadius: appTheme.radii.pill } : null),
              position: 'absolute',
              left: origin.x - piece.width / 2,
              top: origin.y - piece.height / 2,
              width: piece.width,
              height: piece.height,
              backgroundColor: palette[piece.colorIndex % palette.length],
              opacity: value.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
              transform: [
                { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, piece.dx] }) },
                {
                  translateY: value.interpolate({
                    inputRange: [0, 0.38, 1],
                    outputRange: [0, -piece.rise, piece.fall - piece.rise],
                  }),
                },
                { rotate: value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${piece.spin}deg`] }) },
              ],
            }}
          />
        );
      })}
    </View>
  );
}
