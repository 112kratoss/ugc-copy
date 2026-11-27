import { Pencil } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedProps,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import {
  MEDIA_SKETCH_CHIP,
  MEDIA_SKETCH_CYCLE_MS,
  MEDIA_SKETCH_STROKE_LENGTHS,
  MEDIA_SKETCH_STROKES,
  MEDIA_SKETCH_TOTAL_LENGTH,
  MEDIA_SKETCH_VIEWBOX,
  mediaSketchDrawnLength,
  mediaSketchOpacity,
  mediaSketchScale,
  mediaSketchStrokeDrawn,
  mediaSketchTip,
  sketchStrokePath,
} from '@/lib/media-sketch';
import { createListMotion, createSketchClock } from '@/lib/media-sketch-clock';
import { useReducedMotion } from '@/lib/motion';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// One clock for every sketch on screen, as the skeleton bones share one pulse:
// a grid of loading tiles draws in step instead of each running its own timer.
// It runs while any sketch is mounted and stops with the last one, and stands
// still while a list holds it (`useSketchesStillWhileScrolling`): on Android
// each of its frames redraws every sketch into a new bitmap (lib/media-sketch-clock.ts).
const sketchPhase = makeMutable(0);
const sketchClock = createSketchClock({
  start: () => {
    sketchPhase.value = 0;
    sketchPhase.value = withRepeat(withTiming(1, { duration: MEDIA_SKETCH_CYCLE_MS, easing: Easing.linear }), -1, false);
  },
  stop: () => cancelAnimation(sketchPhase),
});

/** How long after a drag let go with no momentum its list counts as at rest. */
const LIST_SETTLE_MS = 120;

/**
 * The scroll handlers of a list whose tiles draw the sketch: while the list
 * moves, every sketch holds still where it is, and a new drawing starts once it
 * rests. A sketch passing under a finger or a fling is not looked at, and each
 * of its frames costs a raster, an allocation and a texture upload on Android,
 * landing on the frames of the scroll (feel audit 2026-11-27).
 */
export function useSketchesStillWhileScrolling() {
  const [list] = useState(() => {
    let release: (() => void) | null = null;
    const motion = createListMotion({
      settleMs: LIST_SETTLE_MS,
      onMove: () => {
        release = sketchClock.hold();
      },
      onRest: () => {
        release?.();
        release = null;
      },
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    });
    return {
      motion,
      handlers: {
        onScrollBeginDrag: () => motion.report('dragBegin'),
        onScrollEndDrag: () => motion.report('dragEnd'),
        onMomentumScrollBegin: () => motion.report('momentumBegin'),
        onMomentumScrollEnd: () => motion.report('momentumEnd'),
      },
    };
  });
  useEffect(() => () => list.motion.dispose(), [list]);
  return list.handlers;
}

const PENCIL_SIZE = 14;
// Where the tip of lucide's pencil sits in its 24-unit drawing, scaled to the icon's size.
const PENCIL_TIP = { x: (2.2 / 24) * PENCIL_SIZE, y: (21.8 / 24) * PENCIL_SIZE };
const STROKE_WIDTH = 1.8;

/**
 * A pencil drawing on a glass chip, centred in its parent: the picture there is
 * still loading (`lib/media-sketch.ts`). Decorative, and never touchable.
 */
export function MediaLoadingSketch() {
  const [scale, setScale] = useState<number | null>(null);

  const measure = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const next = mediaSketchScale(width, height);
    if (next !== scale) setScale(next);
  };

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={measure}
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' }}
    >
      {scale === null ? null : <SketchChip scale={scale} />}
    </View>
  );
}

function SketchChip({ scale }: { scale: number }) {
  const theme = useAppTheme();
  const still = useReducedMotion();

  useEffect(() => {
    if (still) return undefined;
    return sketchClock.retain();
  }, [still]);

  return (
    <View
      style={{
        width: MEDIA_SKETCH_CHIP.width,
        height: MEDIA_SKETCH_CHIP.height,
        borderRadius: appTheme.radii.sm,
        borderCurve: 'continuous',
        backgroundColor: mediaColors.mediaChip,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scale }],
      }}
    >
      <View style={{ width: MEDIA_SKETCH_VIEWBOX.width, height: MEDIA_SKETCH_VIEWBOX.height }}>
        <Svg
          width={MEDIA_SKETCH_VIEWBOX.width}
          height={MEDIA_SKETCH_VIEWBOX.height}
          viewBox={`0 0 ${MEDIA_SKETCH_VIEWBOX.width} ${MEDIA_SKETCH_VIEWBOX.height}`}
        >
          {MEDIA_SKETCH_STROKES.map((stroke, index) => (
            <SketchStroke key={index} index={index} still={still} />
          ))}
        </Svg>
        <SketchPencil still={still} color={theme.colors.primaryFill} />
      </View>
    </View>
  );
}

function SketchStroke({ index, still }: { index: number; still: boolean }) {
  const length = MEDIA_SKETCH_STROKE_LENGTHS[index];
  const animatedProps = useAnimatedProps(() => {
    if (still) return { strokeDashoffset: 0, strokeOpacity: 1 };
    const phase = sketchPhase.value;
    const drawn = mediaSketchStrokeDrawn(mediaSketchDrawnLength(phase), index);
    return {
      strokeDashoffset: length - drawn,
      // Not a dot of round cap where a stroke has yet to start.
      strokeOpacity: drawn <= 0.01 ? 0 : mediaSketchOpacity(phase),
    };
  });

  return (
    <AnimatedPath
      d={sketchStrokePath(MEDIA_SKETCH_STROKES[index])}
      fill="none"
      stroke={mediaColors.onMedia}
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={[length, length]}
      animatedProps={animatedProps}
    />
  );
}

function SketchPencil({ still, color }: { still: boolean; color: string }) {
  const style = useAnimatedStyle(() => {
    const phase = still ? 0 : sketchPhase.value;
    const tip = mediaSketchTip(still ? MEDIA_SKETCH_TOTAL_LENGTH : mediaSketchDrawnLength(phase));
    return {
      opacity: still ? 1 : mediaSketchOpacity(phase),
      transform: [{ translateX: tip.x - PENCIL_TIP.x }, { translateY: tip.y - PENCIL_TIP.y }],
    };
  });

  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, style]}>
      <Pencil size={PENCIL_SIZE} color={color} />
    </Animated.View>
  );
}
