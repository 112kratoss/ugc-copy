import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import {
  MEDIA_SPARKLE_BURST_MOTES,
  MEDIA_SPARKLE_BURST_MS,
  MEDIA_SPARKLE_CANVAS,
  MEDIA_SPARKLE_CLOCK_SPAN_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_DOT,
  MEDIA_SPARKLE_DRIFT_MOTES,
  MEDIA_SPARKLE_GLOW_REACH,
  MEDIA_SPARKLE_HANDOFF_MS,
  MEDIA_SPARKLE_ARM,
  MEDIA_SPARKLE_TRIO,
  MEDIA_SPARKLE_TRIO_FADE_MS,
  mediaSparkleBreath,
  mediaSparkleBurstMote,
  mediaSparkleDotOpacity,
  mediaSparkleDriftFade,
  mediaSparkleDriftMote,
  mediaSparkleGlow,
  mediaSparkleKind,
  mediaSparkleScale,
  mediaSparkleTwinkle,
  sparklePath,
  type MediaSparkleKind,
  type MediaSparkleMoteSpec,
} from '@/lib/media-loading-sparkle';
import { useReducedMotion } from '@/lib/motion';
import { mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * Where the wait stands: still waiting (`loading`), over because the media is
 * ready (`ready`: the sparkle bursts as it goes, as the launch sting ends), or
 * over any other way, a failure or the screen going (`gone`: it goes at once).
 */
export type MediaSparkleState = 'loading' | 'ready' | 'gone';

type Phase = 'idle' | 'waiting' | 'shown' | 'leaving';

const R = MEDIA_SPARKLE_ARM;
const GLOW = MEDIA_SPARKLE_GLOW_REACH;
const CANVAS = MEDIA_SPARKLE_CANVAS;
const CENTER = CANVAS / 2;
const SPARKLE_PATH = sparklePath(R);
/** The motes' colours, as `MediaSparkleMoteSpec.color` counts them: the launch sting's confetti. */
const MOTE_COLORS = [mediaColors.sparkleFrom, mediaColors.sparkleGold, mediaColors.sparkleViolet, mediaColors.sparkleCream];
/** The trio after its first, which takes the logo's gradient. */
const TRIO_COLORS = [mediaColors.sparkleViolet, mediaColors.sparkleCream];
const TRIO = MEDIA_SPARKLE_TRIO;

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

/**
 * When a sparkle last went away while it was showing, its wait not over: the
 * viewer's "Loading preview" screen gives way to the post's page, whose clip
 * is still on its way. A sparkle that starts within `MEDIA_SPARKLE_HANDOFF_MS`
 * of that carries straight on, rather than leaving the screen bare for its
 * own wait (filmed on the Pixel 9a emulator, 2026-11-23).
 */
let sparkleCutShortAt = Number.NEGATIVE_INFINITY;

/**
 * The logo's sparkle on a black screen while a clip or a post is on its way
 * (`lib/media-loading-sparkle.ts`), in place of the spinner. Mount it for as
 * long as the wait can last and say how it stands with `state`: it draws once
 * the wait passes `delayMs`, and stays a moment after `ready` to burst. Read
 * to a screen reader as `label` while it waits, as the spinner was. Fills and
 * centres in its parent, and never takes a touch.
 */
export function MediaLoadingSparkle({
  state,
  label,
  delayMs = MEDIA_SPARKLE_DELAY_MS,
}: {
  state: MediaSparkleState;
  label: string;
  delayMs?: number;
}) {
  const reducedMotion = useReducedMotion();
  const [kind, setKind] = useState<MediaSparkleKind | null>(null);
  const [phase, setPhase] = useState<Phase>(state === 'loading' ? 'waiting' : 'idle');
  // Under Reduce Motion it goes at once; the spinner never had a way out.
  const flourishes = !reducedMotion && (kind === 'sparkle' || kind === 'trio');
  const leaveMs = kind === 'sparkle' ? MEDIA_SPARKLE_BURST_MS : MEDIA_SPARKLE_TRIO_FADE_MS;

  useEffect(() => {
    if (state === 'loading') {
      setPhase((current) => (current === 'shown' ? current : 'waiting'));
      return;
    }
    setPhase((current) => (current === 'shown' && state === 'ready' && flourishes ? 'leaving' : 'idle'));
  }, [state, flourishes]);

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'leaving') return undefined;
    const next: Phase = phase === 'waiting' ? 'shown' : 'idle';
    const sinceCutShort = Date.now() - sparkleCutShortAt;
    const carriesOn = sinceCutShort >= 0 && sinceCutShort < MEDIA_SPARKLE_HANDOFF_MS;
    const wait = phase === 'leaving' ? leaveMs : carriesOn ? 0 : Math.max(0, delayMs);
    const timer = setTimeout(() => setPhase((current) => (current === phase ? next : current)), wait);
    return () => clearTimeout(timer);
  }, [phase, delayMs, leaveMs]);

  // Gone while showing and still waiting: the next sparkle carries on from this one.
  const showing = useRef(false);
  useEffect(() => {
    showing.current = phase === 'shown' && state === 'loading';
  }, [phase, state]);
  useEffect(() => () => {
    if (showing.current) sparkleCutShortAt = Date.now();
  }, []);

  const waiting = state === 'loading';
  // Known in the render that sees `ready`, so the drawing stays mounted into its burst.
  const leaving = phase === 'leaving' || (phase === 'shown' && state === 'ready' && flourishes);
  if (!waiting && !leaving) return null;

  const measure = (event?: LayoutChangeEvent) => {
    const layout = event?.nativeEvent?.layout;
    if (!layout) return;
    const next = mediaSparkleKind(layout.width, layout.height);
    if (next !== kind) setKind(next);
  };

  const drawn = kind !== null && (phase === 'shown' || leaving);
  return (
    <View
      pointerEvents="none"
      onLayout={measure}
      {...(waiting
        ? { accessible: true, accessibilityRole: 'progressbar' as const, accessibilityLabel: label }
        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
      style={{ ...fill, alignItems: 'center', justifyContent: 'center' }}
    >
      {!drawn ? null : kind === 'sparkle' ? (
        <SparkleBurst leaving={leaving} reducedMotion={reducedMotion} />
      ) : kind === 'trio' ? (
        <SparkleTrio leaving={leaving} reducedMotion={reducedMotion} />
      ) : (
        <SpinnerInstead />
      )}
    </View>
  );
}

/** A clock in milliseconds for the drawing, started as it mounts. */
function useSparkleClock() {
  const time = useSharedValue(0);
  useEffect(() => {
    time.value = 0;
    time.value = withRepeat(
      withTiming(MEDIA_SPARKLE_CLOCK_SPAN_MS, { duration: MEDIA_SPARKLE_CLOCK_SPAN_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(time);
  }, [time]);
  return time;
}

/** Milliseconds into the way out once `leaving`, and -1 until then. */
function useLeaveClock(leaving: boolean, durationMs: number) {
  const elapsed = useSharedValue(-1);
  useEffect(() => {
    if (!leaving) {
      cancelAnimation(elapsed);
      elapsed.value = -1;
      return undefined;
    }
    elapsed.value = 0;
    elapsed.value = withTiming(durationMs, { duration: durationMs, easing: Easing.linear });
    return () => cancelAnimation(elapsed);
  }, [elapsed, durationMs, leaving]);
  return elapsed;
}

/** An id for a gradient, unique to this drawing and plain enough for `url(#…)`. */
function useGradientId(name: string) {
  return `${name}${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** The sparkle, its glow and the cream dot, breathing; the burst once it is `leaving`. */
function SparkleBurst({ leaving, reducedMotion }: { leaving: boolean; reducedMotion: boolean }) {
  const time = useSparkleClock();
  const burst = useLeaveClock(leaving, MEDIA_SPARKLE_BURST_MS);
  const glowId = useGradientId('sparkleGlow');
  const fillId = useGradientId('sparkleFill');

  const glowStyle = useAnimatedStyle(() => {
    const strength = reducedMotion ? 0.6 : mediaSparkleGlow(time.value, burst.value);
    return { opacity: strength, transform: [{ scale: 0.85 + 0.3 * strength }] };
  });
  // Under Reduce Motion it brightens and dims in place instead of swelling.
  const sparkleStyle = useAnimatedStyle(() => (reducedMotion
    ? { opacity: 0.65 + 0.35 * mediaSparkleBreath(time.value), transform: [{ scale: 1 }] }
    : { opacity: 1, transform: [{ scale: mediaSparkleScale(time.value, burst.value) }] }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 1 : mediaSparkleDotOpacity(time.value, burst.value),
  }));

  return (
    <View style={{ width: CANVAS, height: CANVAS }}>
      <Animated.View
        style={[{ position: 'absolute', left: CENTER - GLOW, top: CENTER - GLOW, width: 2 * GLOW, height: 2 * GLOW }, glowStyle]}
      >
        <Svg width={2 * GLOW} height={2 * GLOW}>
          <Defs>
            <RadialGradient id={glowId} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={mediaColors.sparkleGlow} stopOpacity={0.6} />
              <Stop offset="0.55" stopColor={mediaColors.sparkleGlow} stopOpacity={0.18} />
              <Stop offset="1" stopColor={mediaColors.sparkleGlow} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={GLOW} cy={GLOW} r={GLOW} fill={`url(#${glowId})`} />
        </Svg>
      </Animated.View>
      {reducedMotion ? null : MEDIA_SPARKLE_DRIFT_MOTES.map((spec, index) => (
        <DriftMote key={`drift-${spec.angle}`} index={index} spec={spec} time={time} burst={burst} />
      ))}
      {reducedMotion ? null : MEDIA_SPARKLE_BURST_MOTES.map((spec, index) => (
        <BurstMote key={`burst-${spec.angle}`} index={index} spec={spec} burst={burst} />
      ))}
      <Animated.View style={[{ position: 'absolute', left: CENTER - R, top: CENTER - R, width: 2 * R, height: 2 * R }, sparkleStyle]}>
        <Svg width={2 * R} height={2 * R}>
          <Defs>
            <LinearGradient id={fillId} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={mediaColors.sparkleFrom} />
              <Stop offset="1" stopColor={mediaColors.sparkleTo} />
            </LinearGradient>
          </Defs>
          <Path d={SPARKLE_PATH} fill={`url(#${fillId})`} />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: CENTER + MEDIA_SPARKLE_DOT.x - MEDIA_SPARKLE_DOT.r,
            top: CENTER + MEDIA_SPARKLE_DOT.y - MEDIA_SPARKLE_DOT.r,
            width: 2 * MEDIA_SPARKLE_DOT.r,
            height: 2 * MEDIA_SPARKLE_DOT.r,
          },
          dotStyle,
        ]}
      >
        <Svg width={2 * MEDIA_SPARKLE_DOT.r} height={2 * MEDIA_SPARKLE_DOT.r}>
          <Circle cx={MEDIA_SPARKLE_DOT.r} cy={MEDIA_SPARKLE_DOT.r} r={MEDIA_SPARKLE_DOT.r} fill={mediaColors.sparkleCream} />
        </Svg>
      </Animated.View>
    </View>
  );
}

function MoteShape({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={2 * size} height={2 * size}>
      <Path d={sparklePath(size)} fill={color} />
    </Svg>
  );
}

function moteBox(size: number) {
  return { position: 'absolute', left: CENTER - size, top: CENTER - size, width: 2 * size, height: 2 * size } as const;
}

/** One of the tiny sparkles each breath sheds. */
function DriftMote({ index, spec, time, burst }: {
  index: number;
  spec: MediaSparkleMoteSpec;
  time: SharedValue<number>;
  burst: SharedValue<number>;
}) {
  const size = spec.size * R;
  const style = useAnimatedStyle(() => {
    const mote = mediaSparkleDriftMote(time.value, index, R);
    return {
      opacity: mote.opacity * mediaSparkleDriftFade(burst.value),
      transform: [{ translateX: mote.x }, { translateY: mote.y }, { scale: mote.scale }],
    };
  });
  return (
    <Animated.View style={[moteBox(size), style]}>
      <MoteShape size={size} color={MOTE_COLORS[spec.color]} />
    </Animated.View>
  );
}

/** One of the tiny sparkles the burst throws out. */
function BurstMote({ index, spec, burst }: { index: number; spec: MediaSparkleMoteSpec; burst: SharedValue<number> }) {
  const size = spec.size * R;
  const style = useAnimatedStyle(() => {
    const mote = mediaSparkleBurstMote(burst.value, index, R);
    return { opacity: mote.opacity, transform: [{ translateX: mote.x }, { translateY: mote.y }, { scale: mote.scale }] };
  });
  return (
    <Animated.View style={[moteBox(size), style]}>
      <MoteShape size={size} color={MOTE_COLORS[spec.color]} />
    </Animated.View>
  );
}

/** Three small sparkles twinkling in turn, for a box too small for the burst; they fade as they go. */
function SparkleTrio({ leaving, reducedMotion }: { leaving: boolean; reducedMotion: boolean }) {
  const time = useSparkleClock();
  const fade = useLeaveClock(leaving, MEDIA_SPARKLE_TRIO_FADE_MS);
  const fillId = useGradientId('trioFill');
  return (
    <View style={{ width: 2 * TRIO.spacing + 2 * TRIO.arm, height: 2 * TRIO.arm }}>
      {[0, 1, 2].map((index) => (
        <TrioSparkle key={index} index={index} time={time} fade={fade} reducedMotion={reducedMotion}>
          {index === 0 ? (
            <>
              <Defs>
                <LinearGradient id={fillId} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={mediaColors.sparkleFrom} />
                  <Stop offset="1" stopColor={mediaColors.sparkleTo} />
                </LinearGradient>
              </Defs>
              <Path d={sparklePath(TRIO.arm)} fill={`url(#${fillId})`} />
            </>
          ) : (
            <Path d={sparklePath(TRIO.arm)} fill={TRIO_COLORS[index - 1]} />
          )}
        </TrioSparkle>
      ))}
    </View>
  );
}

function TrioSparkle({ index, time, fade, reducedMotion, children }: {
  index: number;
  time: SharedValue<number>;
  fade: SharedValue<number>;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const twinkle = mediaSparkleTwinkle(time.value, index);
    const left = fade.value < 0 ? 1 : Math.max(0, 1 - fade.value / MEDIA_SPARKLE_TRIO_FADE_MS);
    // Under Reduce Motion the trio brightens and dims in place.
    return { opacity: (0.3 + 0.7 * twinkle) * left, transform: [{ scale: reducedMotion ? 1 : 0.55 + 0.6 * twinkle }] };
  });
  return (
    <Animated.View
      style={[{ position: 'absolute', left: index * TRIO.spacing, top: 0, width: 2 * TRIO.arm, height: 2 * TRIO.arm }, style]}
    >
      <Svg width={2 * TRIO.arm} height={2 * TRIO.arm}>{children}</Svg>
    </Animated.View>
  );
}

/** A box too small even for the trio keeps the platform's spinner. */
function SpinnerInstead() {
  const theme = useAppTheme();
  return <ActivityIndicator color={theme.colors.primary} />;
}
