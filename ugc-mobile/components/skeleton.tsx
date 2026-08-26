import { useEffect } from 'react';
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

/**
 * Loading placeholders shaped like the content they stand in for. A spinner
 * says "wait"; a skeleton says "here it comes", and the layout does not jump
 * when the real thing lands. Every bone shares one native-driver pulse so a
 * whole screen of them breathes together instead of shimmering out of phase.
 */
function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    // Focused component tests mock react-native down to a few primitives.
    return undefined;
  }
}

const animatedApi = optionalNativeExport(() => Animated);
const easingApi = optionalNativeExport(() => Easing);
// Resolved here rather than imported from lib/motion: some suites mock that
// module down to `useReducedMotion`, and a missing component type is a crash.
const BoneView = (
  optionalNativeExport(() => Animated.View)
  ?? optionalNativeExport(() => View)
  ?? (({ children }: { children?: React.ReactNode }) => children ?? null)
) as typeof Animated.View;

const BONE_FILL = 'rgba(255,248,237,0.07)';
const BONE_FILL_STRONG = 'rgba(255,248,237,0.11)';
const STATIC_OPACITY = 0.7;
const PULSE_MIN_OPACITY = 0.45;
const PULSE_HALF_MS = 820;

let pulse: Animated.Value | null = null;
let pulseLoop: Animated.CompositeAnimation | null = null;
let pulseSubscribers = 0;

function getPulse() {
  if (!pulse && animatedApi?.Value) pulse = new animatedApi.Value(1);
  return pulse;
}

function retainPulse() {
  pulseSubscribers += 1;
  const value = getPulse();
  if (!value || pulseLoop || !animatedApi?.loop || !animatedApi.sequence || !animatedApi.timing) return;

  const easing = easingApi ? easingApi.inOut(easingApi.quad) : undefined;
  pulseLoop = animatedApi.loop(animatedApi.sequence([
    animatedApi.timing(value, { toValue: PULSE_MIN_OPACITY, duration: PULSE_HALF_MS, easing, useNativeDriver: true }),
    animatedApi.timing(value, { toValue: 1, duration: PULSE_HALF_MS, easing, useNativeDriver: true }),
  ]));
  pulseLoop.start();
}

function releasePulse() {
  pulseSubscribers = Math.max(0, pulseSubscribers - 1);
  if (pulseSubscribers === 0 && pulseLoop) {
    pulseLoop.stop();
    pulseLoop = null;
    pulse?.setValue(1);
  }
}

export function SkeletonBone({
  width,
  height,
  radius = appTheme.radii.sm,
  strong = false,
  style,
}: {
  width: DimensionValue;
  height: DimensionValue;
  radius?: number;
  /** Slightly brighter: use for the one or two bones that stand in for the loudest content. */
  strong?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return undefined;
    retainPulse();
    return releasePulse;
  }, [reducedMotion]);

  const value = reducedMotion ? null : getPulse();

  return (
    <BoneView
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius,
          borderCurve: 'continuous',
          backgroundColor: strong ? BONE_FILL_STRONG : BONE_FILL,
          opacity: value ?? STATIC_OPACITY,
        },
        style,
      ]}
    />
  );
}

/** Two feed cards: attribution row, a two-line title, tall media, an action row. */
export function HomeFeedSkeleton({ width, cards = 2 }: { width: number; cards?: number }) {
  const mediaHeight = Math.round(width * 0.95);

  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading posts" style={{ gap: 14 }}>
      {Array.from({ length: cards }, (_, index) => (
        <View
          key={index}
          style={{
            width,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: appTheme.colors.panel,
            overflow: 'hidden',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: appTheme.spacing.card, paddingTop: appTheme.spacing.gap }}>
            <SkeletonBone width={22} height={22} radius={11} strong />
            <SkeletonBone width={92} height={11} radius={6} />
            <View style={{ flex: 1 }} />
            <SkeletonBone width={54} height={20} radius={10} />
          </View>
          <View style={{ gap: 8, paddingHorizontal: appTheme.spacing.card, paddingTop: appTheme.spacing.gap, paddingBottom: appTheme.spacing.gap }}>
            <SkeletonBone width="84%" height={17} radius={6} strong />
            <SkeletonBone width="58%" height={17} radius={6} strong />
          </View>
          <SkeletonBone width="100%" height={mediaHeight} radius={0} />
          <View style={{ flexDirection: 'row', gap: 18, paddingHorizontal: appTheme.spacing.card, paddingVertical: 15 }}>
            <SkeletonBone width={46} height={14} radius={7} />
            <SkeletonBone width={46} height={14} radius={7} />
            <SkeletonBone width={46} height={14} radius={7} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The profile gallery's 3-column grid, sized by the same maths as the live tiles. */
export function ProfileGridSkeleton({
  columns,
  gap,
  cardWidth,
  cardHeight,
  rows = 3,
}: {
  columns: number;
  gap: number;
  cardWidth: number;
  cardHeight: number;
  rows?: number;
}) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading media" style={{ gap }}>
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={{ flexDirection: 'row', gap }}>
          {Array.from({ length: columns }, (_, column) => (
            <SkeletonBone key={column} width={cardWidth} height={cardHeight} radius={12} strong={(row + column) % 3 === 0} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** Comment rows: a small avatar beside two lines of text. */
export function CommentListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading comments" style={{ gap: 18 }}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <SkeletonBone width={25} height={25} radius={12.5} strong />
          <View style={{ flex: 1, gap: 7, paddingTop: 3 }}>
            <SkeletonBone width={index % 2 === 0 ? '38%' : '52%'} height={11} radius={5} strong />
            <SkeletonBone width={index % 3 === 0 ? '92%' : '74%'} height={12} radius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}
/**
 * A list of card rows: leading tile, a title line, a shorter meta line.
 *
 * Stands in for the unlock library and the seller listings, which previously
 * announced themselves with a text card ("Loading unlocks") that vanished and
 * let the real rows jump into place.
 */
export function CardListSkeleton({
  rows = 3,
  label,
}: {
  rows?: number;
  /** What is loading, for assistive technology. */
  label: string;
}) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={{ gap: 12 }}>
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={{
            flexDirection: 'row',
            gap: 12,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: appTheme.colors.panel,
            borderRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            padding: appTheme.spacing.card,
          }}
        >
          <SkeletonBone width={56} height={56} radius={14} strong />
          <View style={{ flex: 1, gap: 8 }}>
            {/* Uneven widths so the stack reads as content rather than a pattern. */}
            <SkeletonBone width={index % 2 === 0 ? '72%' : '58%'} height={13} radius={6} strong />
            <SkeletonBone width={index % 3 === 0 ? '44%' : '36%'} height={11} radius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A detail panel: a heading line, a few body lines, then an action bar.
 *
 * Stands in for the marketplace and unlock detail screens, which announced
 * themselves with a text card that vanished and let the panel jump in.
 */
export function DetailSkeleton({ label }: { label: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{
        gap: 14,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.panel,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        padding: appTheme.spacing.panel,
      }}
    >
      <SkeletonBone width="62%" height={18} radius={8} strong />
      <View style={{ gap: 9 }}>
        <SkeletonBone width="100%" height={12} radius={5} />
        <SkeletonBone width="88%" height={12} radius={5} />
        <SkeletonBone width="54%" height={12} radius={5} />
      </View>
      <SkeletonBone width="100%" height={appTheme.touch.default} radius={appTheme.radii.pill} strong />
    </View>
  );
}

/**
 * A row of stat tiles: the invite metrics grid, which loads as a unit.
 */
export function MetricGridSkeleton({ tiles = 4, label }: { tiles?: number; label: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: appTheme.spacing.gap }}
    >
      {Array.from({ length: tiles }, (_, index) => (
        <View
          key={index}
          style={{
            flexGrow: 1,
            flexBasis: '44%',
            gap: 10,
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: appTheme.colors.panel,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            padding: appTheme.spacing.card,
          }}
        >
          <SkeletonBone width={22} height={22} radius={11} />
          <SkeletonBone width="46%" height={20} radius={8} strong />
          <SkeletonBone width="70%" height={11} radius={5} />
        </View>
      ))}
    </View>
  );
}

/**
 * A creator page: identity header, stat row, then a grid of work.
 *
 * Replaces a lone spinner on an empty screen. HIG is explicit that showing
 * nothing while loading reads as a broken app rather than a busy one, and a
 * blank page with a small spinner in the middle is the version of that mistake
 * that is easiest to ship.
 */
export function CreatorProfileSkeleton({ label = 'Loading creator' }: { label?: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flex: 1, gap: appTheme.spacing.section, padding: appTheme.spacing.screen }}
    >
      <View style={{ gap: appTheme.spacing.gap }}>
        <SkeletonBone width="100%" height={104} radius={appTheme.radii.xl} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.gap }}>
          <SkeletonBone width={64} height={64} radius={32} strong />
          <View style={{ flex: 1, gap: 8 }}>
            <SkeletonBone width="54%" height={18} radius={8} strong />
            <SkeletonBone width="34%" height={12} radius={5} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: appTheme.spacing.section }}>
          {Array.from({ length: 3 }, (_, index) => (
            <View key={index} style={{ gap: 6 }}>
              <SkeletonBone width={34} height={16} radius={6} strong />
              <SkeletonBone width={46} height={10} radius={4} />
            </View>
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: appTheme.spacing.gap }}>
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonBone
            key={index}
            width="47%"
            height={index % 2 === 0 ? 210 : 168}
            radius={appTheme.radii.lg}
            strong={index === 0}
          />
        ))}
      </View>
    </View>
  );
}
