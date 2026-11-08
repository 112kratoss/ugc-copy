import { Sparkle } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The claim's celebration (owner, 2026-11-09: confetti "seems very childish ...
 * make it some premium feel"): one soft halo that ripples out of the Claim
 * button, and a dozen of the brand's sparkles (✦) in coral and gold that drift
 * up from it, twinkle and fade, staggered. Few pieces, one strong ease-out
 * curve, under a second and a half. Transforms and opacity on the native
 * driver only; nothing under Reduce Motion. Not touchable.
 */
const SPARKLE_COUNT = 12;
const SPARKLE_MS = 1250;
const HALO_MS = 700;
/** Emil's strong ease-out: instant on the way out, a long soft settle. */
const STRONG_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

export type ClaimFrame = { x: number; y: number; width: number; height: number };

type SparklePiece = {
  /** Where along the button it starts, -0.5..0.5 of its width. */
  along: number;
  rise: number;
  drift: number;
  peakScale: number;
  turn: number;
  delay: number;
  tone: number;
};

/** Seeded, so the celebration is the same every time (and in tests). */
export function claimSparklePieces(count = SPARKLE_COUNT, seed = 11): SparklePiece[] {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
  return Array.from({ length: count }, (_, index) => ({
    along: (index / Math.max(1, count - 1) - 0.5) * 0.8 + (next() - 0.5) * 0.08,
    rise: 70 + next() * 110,
    drift: (next() - 0.5) * 48,
    peakScale: 0.7 + next() * 0.6,
    turn: (next() - 0.5) * 50,
    // A cascade, 30–60 ms apart, in a shuffled order so it reads as scattered.
    delay: Math.round(((index * 7) % count) * 34 + next() * 20),
    tone: index % 3,
  }));
}

export function ClaimSparkles({ play, frame }: { play: boolean; frame: ClaimFrame | null }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [pieces] = useState(() => claimSparklePieces());
  const [halo] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [progress] = useState(() => pieces.map(() => new Animated.Value(0, { useNativeDriver: true })));
  const tones = [theme.colors.primaryFill, theme.colors.navigationCreateTop, theme.colors.primary];

  useEffect(() => {
    if (!play || reducedMotion || !frame) return;
    halo.setValue(0);
    const animations = [
      Animated.timing(halo, { toValue: 1, duration: HALO_MS, easing: STRONG_EASE_OUT, useNativeDriver: true }),
      ...progress.map((value, index) => {
        value.setValue(0);
        return Animated.timing(value, {
          toValue: 1,
          duration: SPARKLE_MS,
          delay: pieces[index].delay,
          easing: STRONG_EASE_OUT,
          useNativeDriver: true,
        });
      }),
    ];
    const celebration = Animated.parallel(animations);
    celebration.start();
    return () => celebration.stop();
  }, [play, frame, halo, pieces, progress, reducedMotion]);

  if (!play || reducedMotion || !frame) return null;

  const centreX = frame.x + frame.width / 2;
  const startY = frame.y + frame.height * 0.3;
  const glyph = appTheme.icon.sm;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', inset: 0 }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          borderRadius: appTheme.radii.pill,
          borderWidth: 2,
          borderColor: theme.colors.primaryFill,
          opacity: halo.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.6, 0] }),
          transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] }) }],
        }}
      />
      {pieces.map((piece, index) => {
        const value = progress[index];
        const tone = tones[piece.tone % tones.length];
        return (
          <Animated.View
            key={index}
            style={{
              position: 'absolute',
              left: centreX + piece.along * frame.width - glyph / 2,
              top: startY - glyph / 2,
              opacity: value.interpolate({ inputRange: [0, 0.12, 0.65, 1], outputRange: [0, 1, 0.9, 0] }),
              transform: [
                { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, piece.drift] }) },
                { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -piece.rise] }) },
                {
                  scale: value.interpolate({
                    inputRange: [0, 0.25, 0.6, 1],
                    outputRange: [0.3, piece.peakScale, piece.peakScale * 0.8, 0.4],
                  }),
                },
                { rotate: value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${piece.turn}deg`] }) },
              ],
            }}
          >
            <Sparkle size={glyph} color={tone} fill={tone} />
          </Animated.View>
        );
      })}
    </View>
  );
}
