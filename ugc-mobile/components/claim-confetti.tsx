import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import {
  CLAIM_CONFETTI_TONES,
  CONFETTI_FLUTTER_STEPS,
  CONFETTI_OPACITY,
  CONFETTI_OPACITY_STEPS,
  claimConfettiPieces,
  confettiFlutter,
  confettiPathSteps,
  type ClaimOrigin,
} from '@/lib/claim-confetti-flight/claim-confetti-flight';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The claim's confetti (owner, 2026-11-09: "confetti ... in many many apps, a
 * similar premium feel which gives the user a satisfaction of gaining
 * something"). The flight itself, seeded and the same every time, is shared
 * with the web (`lib/claim-confetti-flight/`): thin strips, small chips and a
 * few dots in the brand's coral, gold, deep orange, peach and white, thrown up
 * and out of the figure in one burst, falling under gravity with air drag,
 * tumbling, fading as they land. Here it is played on the native driver as
 * transforms and opacity only; nothing under Reduce Motion. Not touchable.
 */
export {
  CLAIM_CONFETTI_MS,
  claimConfettiPieces,
  type ClaimOrigin,
  type ConfettiPiece,
} from '@/lib/claim-confetti-flight/claim-confetti-flight';

/**
 * `ready` mounts the pieces, invisible, at the origin; `play` throws them. Mount
 * them ahead of the landing: building 48 native-driven views costs the JS
 * thread a frame or two, which held the figure on the credit before last.
 */
export function ClaimConfetti({ ready, play, origin }: { ready: boolean; play: boolean; origin: ClaimOrigin | null }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [pieces] = useState(() => claimConfettiPieces());
  const [progress] = useState(() => pieces.map(() => new Animated.Value(0, { useNativeDriver: true })));
  const tones = CLAIM_CONFETTI_TONES.map((name) => theme.colors[name]);

  useEffect(() => {
    if (!play || reducedMotion || !origin) return;
    const burst = Animated.parallel(progress.map((value, index) => {
      value.setValue(0);
      return Animated.timing(value, {
        toValue: 1,
        duration: pieces[index].duration,
        delay: pieces[index].delay,
        easing: Easing.linear,
        useNativeDriver: true,
      });
    }));
    burst.start();
    return () => burst.stop();
  }, [play, origin, pieces, progress, reducedMotion]);

  if (!(ready || play) || reducedMotion || !origin) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', inset: 0 }}
    >
      {pieces.map((piece, index) => {
        const value = progress[index];
        const steps = confettiPathSteps(piece);
        return (
          <Animated.View
            key={index}
            style={{
              position: 'absolute',
              left: origin.x - piece.width / 2,
              top: origin.y - piece.height / 2,
              width: piece.width,
              height: piece.height,
              // Three shapes: a capsule strip, a square chip, a round dot.
              borderRadius: piece.shape === 'chip' ? 0 : appTheme.radii.pill,
              borderCurve: 'continuous',
              backgroundColor: tones[piece.tone],
              opacity: value.interpolate({ inputRange: CONFETTI_OPACITY_STEPS, outputRange: CONFETTI_OPACITY }),
              transform: [
                { translateX: value.interpolate({ inputRange: steps, outputRange: piece.path.map((point) => point.x) }) },
                { translateY: value.interpolate({ inputRange: steps, outputRange: piece.path.map((point) => point.y) }) },
                { rotate: value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${piece.spin}deg`] }) },
                // A tumble: the piece turns edge-on and back four times over its flight.
                { scaleX: value.interpolate({ inputRange: CONFETTI_FLUTTER_STEPS, outputRange: confettiFlutter(piece) }) },
              ],
            }}
          />
        );
      })}
    </View>
  );
}
