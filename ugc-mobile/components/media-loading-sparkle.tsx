import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import {
  MEDIA_SPARKLE_CLOCK_SPAN_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_FADE_MS,
  MEDIA_SPARKLE_HANDOFF_MS,
  MEDIA_SPARKLE_TRIO,
  mediaSparkleLook,
  mediaSparkleTrioScale,
  sparklePath,
  type MediaSparkleState,
} from '@/lib/media-loading-sparkle';
import { useReducedMotion } from '@/lib/motion';
import { mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export type { MediaSparkleState } from '@/lib/media-loading-sparkle';

type Phase = 'idle' | 'waiting' | 'shown' | 'leaving';

/** The second and third sparkles; the first takes the logo's coral gradient. */
const TRIO_COLORS = [mediaColors.sparkleViolet, mediaColors.sparkleCream];

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

/**
 * When sparkles of each hand-off (`handoff`) last went away while they were
 * showing, their wait not over: the viewer's "Loading preview" screen gives
 * way to the post's page, whose clip is still on its way. Sparkles of the same
 * hand-off that start within `MEDIA_SPARKLE_HANDOFF_MS` of that carry straight
 * on, rather than leaving the screen bare for their own wait (filmed on the
 * Pixel 9a emulator, 2026-11-23). Only the first to start takes it over, and a
 * player of another surface never does: a lightbox closed mid-wait must not
 * hurry the next clip's sparkles on.
 */
const cutShortAt = new Map<string, number>();

/**
 * Three of the logo's sparkles twinkling on a black screen while a clip or a
 * post is on its way (`lib/media-loading-sparkle.ts`), in place of the
 * spinner. Mount it for as long as the wait can last and say how it stands
 * with `state` (`mediaSparkleStateFor` reads it from a player's status): the
 * sparkles show once the wait passes `delayMs`, and fade after `ready`. Read
 * to a screen reader as `label` while it waits, as the spinner was, from a
 * small view at the centre that covers nothing else. Fills its parent and
 * never takes a touch.
 */
export function MediaLoadingSparkle({
  state,
  label,
  delayMs = MEDIA_SPARKLE_DELAY_MS,
  handoff,
}: {
  state: MediaSparkleState;
  label: string;
  delayMs?: number;
  /** A name shared by the loaders that hand over to one another, as the viewer's black screen does to its post's page. */
  handoff?: string;
}) {
  const reducedMotion = useReducedMotion();
  // Unknown until the box is measured; `null` for a box that keeps the spinner.
  const [scale, setScale] = useState<number | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>(state === 'loading' ? 'waiting' : 'idle');
  // Under Reduce Motion they go at once; the spinner never had a way out.
  const fades = !reducedMotion && typeof scale === 'number';

  useEffect(() => {
    if (state === 'loading') {
      // Waiting again during the fade: they carry on, rather than vanish for the delay and come back.
      setPhase((current) => (current === 'shown' || current === 'leaving' ? 'shown' : 'waiting'));
      return;
    }
    setPhase((current) => (current === 'shown' && state === 'ready' && fades ? 'leaving' : 'idle'));
  }, [state, fades]);

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'leaving') return undefined;
    const next: Phase = phase === 'waiting' ? 'shown' : 'idle';
    let wait = phase === 'leaving' ? MEDIA_SPARKLE_FADE_MS : Math.max(0, delayMs);
    if (phase === 'waiting' && handoff) {
      const since = Date.now() - (cutShortAt.get(handoff) ?? Number.NEGATIVE_INFINITY);
      if (since >= 0 && since < MEDIA_SPARKLE_HANDOFF_MS) {
        cutShortAt.delete(handoff);
        wait = 0;
      }
    }
    const timer = setTimeout(() => setPhase((current) => (current === phase ? next : current)), wait);
    return () => clearTimeout(timer);
  }, [phase, delayMs, handoff]);

  // Gone while showing and still waiting: the next sparkles of the hand-off carry on from these.
  const showing = useRef(false);
  useEffect(() => {
    showing.current = phase === 'shown' && state === 'loading';
  }, [phase, state]);
  useEffect(() => () => {
    if (handoff && showing.current) cutShortAt.set(handoff, Date.now());
  }, [handoff]);

  const waiting = state === 'loading';
  // Known in the render that sees `ready`, so the drawing stays mounted into its fade.
  const leaving = phase === 'leaving' || (phase === 'shown' && state === 'ready' && fades);
  if (!waiting && !leaving) return null;

  const measure = (event?: LayoutChangeEvent) => {
    const layout = event?.nativeEvent?.layout;
    if (!layout) return;
    const next = mediaSparkleTrioScale(layout.width, layout.height);
    if (next !== scale) setScale(next);
  };

  const drawn = scale !== undefined && (phase === 'shown' || leaving);
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no"
      onLayout={measure}
      style={{ ...fill, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* The screen reader's element: small and centred, so a reader touching the screen's
          own controls (Back, Mute, a slide's play) finds them, not this. */}
      <View
        {...(waiting
          ? { accessible: true, accessibilityRole: 'progressbar' as const, accessibilityLabel: label }
          : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
        style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        {!drawn ? null : scale === null ? <SpinnerInstead /> : (
          <SparkleTrio scale={scale} leaving={leaving} reducedMotion={reducedMotion} />
        )}
      </View>
    </View>
  );
}

/**
 * A clock in milliseconds for the twinkle, started as the sparkles mount. It
 * runs whatever the phone's Reduce Motion says (Reanimated's default would
 * jump it to its end and stop it there, every sparkle dim): under Reduce
 * Motion the sparkles still brighten and dim, they only do not grow.
 */
function useSparkleClock() {
  const time = useSharedValue(0);
  useEffect(() => {
    time.value = 0;
    time.value = withRepeat(
      withTiming(MEDIA_SPARKLE_CLOCK_SPAN_MS, {
        duration: MEDIA_SPARKLE_CLOCK_SPAN_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(time);
  }, [time]);
  return time;
}

/** Milliseconds into the fade once `leaving`, and -1 until then. */
function useFadeClock(leaving: boolean) {
  const elapsed = useSharedValue(-1);
  useEffect(() => {
    if (!leaving) {
      cancelAnimation(elapsed);
      elapsed.value = -1;
      return undefined;
    }
    elapsed.value = 0;
    elapsed.value = withTiming(MEDIA_SPARKLE_FADE_MS, { duration: MEDIA_SPARKLE_FADE_MS, easing: Easing.linear });
    return () => cancelAnimation(elapsed);
  }, [elapsed, leaving]);
  return elapsed;
}

/** Three sparkles in a row at `scale`, each twinkling a little after the one before. */
function SparkleTrio({ scale, leaving, reducedMotion }: { scale: number; leaving: boolean; reducedMotion: boolean }) {
  const time = useSparkleClock();
  const fade = useFadeClock(leaving);
  // A gradient id unique to this drawing and plain enough for `url(#…)`.
  const fillId = `sparkleFill${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const arm = MEDIA_SPARKLE_TRIO.arm * scale;
  const spacing = MEDIA_SPARKLE_TRIO.spacing * scale;
  const path = sparklePath(arm);
  return (
    <View style={{ width: 2 * spacing + 2 * arm, height: 2 * arm }}>
      {[0, 1, 2].map((index) => (
        <TrioSparkle key={index} index={index} arm={arm} left={index * spacing} time={time} fade={fade} reducedMotion={reducedMotion}>
          {index === 0 ? (
            <>
              <Defs>
                <LinearGradient id={fillId} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={mediaColors.sparkleFrom} />
                  <Stop offset="1" stopColor={mediaColors.sparkleTo} />
                </LinearGradient>
              </Defs>
              <Path d={path} fill={`url(#${fillId})`} />
            </>
          ) : (
            <Path d={path} fill={TRIO_COLORS[index - 1]} />
          )}
        </TrioSparkle>
      ))}
    </View>
  );
}

function TrioSparkle({ index, arm, left, time, fade, reducedMotion, children }: {
  index: number;
  arm: number;
  left: number;
  time: SharedValue<number>;
  fade: SharedValue<number>;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const look = mediaSparkleLook(time.value, index, fade.value, reducedMotion);
    return { opacity: look.opacity, transform: [{ scale: look.scale }] };
  });
  return (
    <Animated.View style={[{ position: 'absolute', left, top: 0, width: 2 * arm, height: 2 * arm }, style]}>
      <Svg width={2 * arm} height={2 * arm}>{children}</Svg>
    </Animated.View>
  );
}

/** A box too small for the sparkles keeps the platform's spinner. */
function SpinnerInstead() {
  const theme = useAppTheme();
  return <ActivityIndicator color={theme.colors.primary} />;
}
