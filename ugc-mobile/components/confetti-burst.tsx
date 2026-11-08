import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** A subtle burst: few, small pieces, about a second (owner, 2026-11-09). */
const PIECE_COUNT = 26;
const BURST_MS = 1150;

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
    const size = 5 + Math.round(next() * 3);
    return {
      dx: (next() - 0.5) * 300,
      rise: 70 + next() * 90,
      fall: 160 + next() * 120,
      spin: (next() - 0.5) * 720,
      width: size,
      height: round ? size : size + 4,
      delay: Math.round(next() * 120),
      colorIndex: index,
    };
  });
}

/**
 * Plays once when `play` turns true. Pieces start at the top centre of the
 * parent and arc out and down, fading as they fall. Native-driven transforms
 * and opacity only; nothing under Reduce Motion. Not touchable.
 */
export function ConfettiBurst({ play }: { play: boolean }) {
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

  if (!play || reducedMotion) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: 0, right: 0, top: appTheme.spacing.panel, alignItems: 'center' }}
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
              width: piece.width,
              height: piece.height,
              backgroundColor: palette[piece.colorIndex % palette.length],
              opacity: value.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
              transform: [
                { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, piece.dx] }) },
                {
                  translateY: value.interpolate({
                    inputRange: [0, 0.35, 1],
                    outputRange: [0, -piece.rise, piece.fall],
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
