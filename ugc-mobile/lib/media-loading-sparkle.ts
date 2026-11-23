/**
 * The loading sparkle: while a clip or a post is on its way to a screen that
 * is still black (the full-screen viewer, a video player), the logo's coral
 * sparkle breathes in its warm glow and sheds a few tiny sparkles, as the
 * launch sting does (`assets/video/splash-sting-*.mp4`). When the media is
 * ready it bursts as the sting ends, and the media is there behind it
 * (`components/media-loading-sparkle.tsx`). The owner chose it on 2026-11-23
 * over a pencil on a card, which "feels like a big obstruction".
 *
 * A box too small for the glow and the burst gets three small sparkles that
 * twinkle in turn (the trio), and one smaller still the platform spinner.
 *
 * It waits `MEDIA_SPARKLE_DELAY_MS` first, as the picture sketch does
 * (`lib/media-sketch.ts`): a clip from the cache never flashes a sparkle.
 *
 * Pure: no React Native imports, so the timing and geometry can be tested.
 * Functions marked `'worklet'` also run on the UI thread. Times are in
 * milliseconds and lengths in points.
 */
import { MEDIA_SKETCH_DELAY_MS } from './media-sketch';

export type MediaSparkleKind = 'sparkle' | 'trio' | 'spinner';

/** Where a mote is and how it looks at one moment: offset from the sparkle's centre, scale and opacity. */
export type MediaSparkleMote = { x: number; y: number; scale: number; opacity: number };

/**
 * One mote: its direction in degrees (0 points right, turning clockwise), how
 * far it travels and its size (both as shares of the sparkle's radius), its
 * colour (an index into the palette the component draws with: the launch
 * sting's coral, gold, violet and cream) and how long after the others it sets off.
 */
export type MediaSparkleMoteSpec = { angle: number; reach: number; size: number; color: number; delayMs: number };

/** Wait this long after the wait starts before anything is drawn: the picture sketch's wait. */
export const MEDIA_SPARKLE_DELAY_MS = MEDIA_SKETCH_DELAY_MS;
/**
 * A sparkle that starts this soon after another went away mid-wait carries
 * straight on with no wait of its own: the viewer's black screen handing over
 * to the post's page while its clip is still coming. The page's own starts
 * once the reel has landed, about 350 ms after the black screen went on the
 * Pixel 9a emulator (2026-11-23), so a quarter of a second missed it.
 */
export const MEDIA_SPARKLE_HANDOFF_MS = 1000;

/** The sparkle's size: from its centre to the tip of a point. */
export const MEDIA_SPARKLE_ARM = 22;
/** The glow behind it. */
export const MEDIA_SPARKLE_GLOW_REACH = 55;
/** The square everything is drawn in, centred on the sparkle: the burst's farthest mote fits inside. */
export const MEDIA_SPARKLE_CANVAS = 200;
/** The logo's cream dot beside the sparkle's upper right, where the icon has it. */
export const MEDIA_SPARKLE_DOT = { x: 27.5, y: -25.7, r: 4.4 } as const;

/** A box this big both ways takes the sparkle with its glow and burst. */
export const MEDIA_SPARKLE_MIN_BOX = 180;
/** A smaller box down to this takes the trio; anything smaller the platform spinner. */
export const MEDIA_SPARKLE_TRIO_MIN_BOX = { width: 64, height: 36 } as const;

/** One breath: the sparkle swells and settles, and sheds its motes at the top. */
export const MEDIA_SPARKLE_BREATH_MS = 1600;
/** A shed mote's flight. */
const DRIFT_LIFE_MS = 1000;
/** Each breath turns its motes this much further round, so no two breaths look alike. */
const DRIFT_TURN_DEG = 47;
/** The motes set off from this share of the radius, just outside the sparkle's waist. */
const MOTE_START = 0.6;

/** The burst once the media is ready: the sparkle swells, then pops as its motes fly out. */
const BURST_SWELL_MS = 140;
const BURST_SHRINK_MS = 220;
const BURST_MOTE_LIFE_MS = 560;
const BURST_GLOW_FADE_MS = 300;
const BURST_DOT_FADE_MS = 250;
const BURST_DRIFT_FADE_MS = 120;
/** How long the burst lasts, after which the sparkle is taken away. */
export const MEDIA_SPARKLE_BURST_MS = BURST_SWELL_MS + BURST_MOTE_LIFE_MS + 20;

/** The trio: three small sparkles in a row, each twinkling a little after the one before. */
export const MEDIA_SPARKLE_TRIO = { arm: 6, spacing: 18, cycleMs: 1200, pulseMs: 520, staggerMs: 180 } as const;
/** The trio fades as the media comes in, with no burst. */
export const MEDIA_SPARKLE_TRIO_FADE_MS = 180;

/**
 * The span of the clock the drawing runs on before it starts over: far longer
 * than any wait, and a whole number of breaths and trio cycles, so the loop
 * has no seam.
 */
export const MEDIA_SPARKLE_CLOCK_SPAN_MS = 600_000;

/** The three motes each breath sheds. */
// Sizes as filmed on the Pixel 9a emulator (2026-11-23): at 0.12 to 0.2 of the
// radius the shed motes were specks nobody would see over a blurred preview.
export const MEDIA_SPARKLE_DRIFT_MOTES: readonly MediaSparkleMoteSpec[] = [
  { angle: -70, reach: 1.3, size: 0.24, color: 0, delayMs: 0 },
  { angle: 25, reach: 1.7, size: 0.2, color: 2, delayMs: 90 },
  { angle: 155, reach: 1.5, size: 0.28, color: 3, delayMs: 180 },
];

/** The twelve motes of the burst, all the way round, a little uneven as the sting's are. */
export const MEDIA_SPARKLE_BURST_MOTES: readonly MediaSparkleMoteSpec[] = [
  { angle: 8, reach: 3.4, size: 0.25, color: 0, delayMs: 0 },
  { angle: 18, reach: 2.6, size: 0.18, color: 1, delayMs: 10 },
  { angle: 65, reach: 3.7, size: 0.32, color: 2, delayMs: 0 },
  { angle: 104, reach: 2.9, size: 0.15, color: 3, delayMs: 20 },
  { angle: 114, reach: 3.6, size: 0.22, color: 0, delayMs: 0 },
  { angle: 160, reach: 2.4, size: 0.3, color: 1, delayMs: 10 },
  { angle: 171, reach: 3.1, size: 0.19, color: 2, delayMs: 0 },
  { angle: 213, reach: 3.6, size: 0.28, color: 3, delayMs: 20 },
  { angle: 252, reach: 2.7, size: 0.16, color: 0, delayMs: 0 },
  { angle: 266, reach: 3.5, size: 0.31, color: 1, delayMs: 10 },
  { angle: 307, reach: 2.5, size: 0.21, color: 2, delayMs: 0 },
  { angle: 319, reach: 3.2, size: 0.25, color: 3, delayMs: 20 },
];

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function easeOutCubic(x: number) {
  'worklet';
  return 1 - (1 - x) ** 3;
}

/** What a box this size takes while it waits. */
export function mediaSparkleKind(width: number, height: number): MediaSparkleKind {
  if (width >= MEDIA_SPARKLE_MIN_BOX && height >= MEDIA_SPARKLE_MIN_BOX) return 'sparkle';
  if (width >= MEDIA_SPARKLE_TRIO_MIN_BOX.width && height >= MEDIA_SPARKLE_TRIO_MIN_BOX.height) return 'trio';
  return 'spinner';
}

/**
 * The logo's four-pointed sparkle (`assets/images/icon.png`): points up, right,
 * down and left, each side curving in toward the middle. Centred on `(cx, cy)`,
 * by default the middle of a square twice the radius wide.
 */
export function sparklePath(radius: number, cx = radius, cy = radius): string {
  const r = radius;
  const a = 0.06 * r;
  const b = 0.3 * r;
  const p = (x: number, y: number) => `${round2(cx + x)} ${round2(cy + y)}`;
  return [
    `M${p(0, -r)}`,
    `C${p(a, -b)} ${p(b, -a)} ${p(r, 0)}`,
    `C${p(b, a)} ${p(a, b)} ${p(0, r)}`,
    `C${p(-a, b)} ${p(-b, a)} ${p(-r, 0)}`,
    `C${p(-b, -a)} ${p(-a, -b)} ${p(0, -r)}`,
    'Z',
  ].join(' ');
}

/** How far into its breath the sparkle is at `time`: 0 at rest, 1 at the top. */
export function mediaSparkleBreath(time: number): number {
  'worklet';
  const phase = (time % MEDIA_SPARKLE_BREATH_MS) / MEDIA_SPARKLE_BREATH_MS;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
}

/** The sparkle's scale at `time`, or `burstMs` into its burst (negative while it waits). */
export function mediaSparkleScale(time: number, burstMs: number): number {
  'worklet';
  if (burstMs < 0) return 0.92 + 0.12 * mediaSparkleBreath(time);
  if (burstMs < BURST_SWELL_MS) return 1 + 0.3 * easeOutCubic(burstMs / BURST_SWELL_MS);
  const shrink = Math.min(1, (burstMs - BURST_SWELL_MS) / BURST_SHRINK_MS);
  return 1.3 * (1 - easeOutCubic(shrink));
}

/** The glow's strength at the same moment: its opacity, and how far it reaches. */
export function mediaSparkleGlow(time: number, burstMs: number): number {
  'worklet';
  if (burstMs < 0) return 0.45 + 0.4 * mediaSparkleBreath(time);
  if (burstMs < BURST_SWELL_MS) return 0.85 + 0.15 * (burstMs / BURST_SWELL_MS);
  return Math.max(0, 1 - (burstMs - BURST_SWELL_MS) / BURST_GLOW_FADE_MS);
}

/** The cream dot's opacity: it breathes with the sparkle and goes first in the burst. */
export function mediaSparkleDotOpacity(time: number, burstMs: number): number {
  'worklet';
  if (burstMs < 0) return 0.6 + 0.4 * mediaSparkleBreath(time);
  return Math.max(0, 1 - burstMs / BURST_DOT_FADE_MS);
}

/** How much of a shed mote still shows `burstMs` into the burst: the burst's own motes take over. */
export function mediaSparkleDriftFade(burstMs: number): number {
  'worklet';
  return burstMs < 0 ? 1 : Math.max(0, 1 - burstMs / BURST_DRIFT_FADE_MS);
}

function moteAt(angleDeg: number, distance: number, progress: number): MediaSparkleMote {
  'worklet';
  const angle = (angleDeg * Math.PI) / 180;
  // Up quickly, then fading for the rest of the flight; smaller as it goes.
  const opacity = progress < 0.15 ? progress / 0.15 : 1 - (progress - 0.15) / 0.85;
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    scale: 1 - 0.5 * progress,
    opacity,
  };
}

/** Shed mote `index` at `time`, for a sparkle of `radius`: each breath sheds the three at its top. */
export function mediaSparkleDriftMote(time: number, index: number, radius: number): MediaSparkleMote {
  'worklet';
  const spec = MEDIA_SPARKLE_DRIFT_MOTES[index];
  const half = MEDIA_SPARKLE_BREATH_MS / 2;
  // The latest top of a breath at or before `time`.
  const breath = Math.floor((time - half) / MEDIA_SPARKLE_BREATH_MS);
  const shedAt = breath * MEDIA_SPARKLE_BREATH_MS + half;
  const progress = (time - shedAt - spec.delayMs) / DRIFT_LIFE_MS;
  if (breath < 0 || progress < 0 || progress >= 1) return { x: 0, y: 0, scale: 0, opacity: 0 };
  return moteAt(spec.angle + breath * DRIFT_TURN_DEG, radius * (MOTE_START + spec.reach * easeOutCubic(progress)), progress);
}

/** Burst mote `index` `burstMs` into the burst, for a sparkle of `radius`. */
export function mediaSparkleBurstMote(burstMs: number, index: number, radius: number): MediaSparkleMote {
  'worklet';
  const spec = MEDIA_SPARKLE_BURST_MOTES[index];
  const progress = (burstMs - BURST_SWELL_MS - spec.delayMs) / BURST_MOTE_LIFE_MS;
  if (burstMs < 0 || progress < 0 || progress >= 1) return { x: 0, y: 0, scale: 0, opacity: 0 };
  return moteAt(spec.angle, radius * (0.5 + spec.reach * easeOutCubic(progress)), progress);
}

/** How bright trio sparkle `index` (0 to 2) is at `time`: 0 between its twinkles, 1 at the top of one. */
export function mediaSparkleTwinkle(time: number, index: number): number {
  'worklet';
  const { cycleMs, pulseMs, staggerMs } = MEDIA_SPARKLE_TRIO;
  const local = ((((time - index * staggerMs) % cycleMs) + cycleMs) % cycleMs) / pulseMs;
  return local >= 1 ? 0 : Math.sin(Math.PI * local);
}
