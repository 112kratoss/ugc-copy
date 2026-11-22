/**
 * The loading sketch: while a picture is still on its way, a pencil draws a
 * small landscape on a glass chip in the middle of the picture's box
 * (`components/media-sketch.tsx`, drawn by `StableMediaImage`). The picture's
 * blurred placeholder stays visible around it, and the chip goes the moment
 * the picture is on screen.
 *
 * Two rules keep it from becoming noise:
 * - It waits `MEDIA_SKETCH_DELAY_MS` first. Most pictures come from the image
 *   cache within a frame or two, and a pencil that flashed up on every tile of
 *   a scrolled grid would read as flicker.
 * - It draws only in a box big enough to hold it, shrinking a little for a
 *   smaller one (`mediaSketchScale`): an avatar-sized thumbnail keeps its
 *   placeholder alone.
 *
 * A caller opts in (`StableMediaImage`'s `loadingSketch`), because the chip is
 * centred in the image's parent, which must be the box the image fills.
 *
 * Pure: no React Native imports, so the geometry and timing can be tested.
 * Functions marked `'worklet'` also run on the UI thread.
 */

export type SketchPoint = { x: number; y: number };
export type SketchStroke = readonly SketchPoint[];

/** Wait this long after a picture starts loading before the sketch appears. */
export const MEDIA_SKETCH_DELAY_MS = 350;
/** One draw, hold and fade of the sketch, in milliseconds. */
export const MEDIA_SKETCH_CYCLE_MS = 2400;

/** The drawing's own coordinates (its viewBox), and the chip it sits on, in points at full size. */
export const MEDIA_SKETCH_VIEWBOX = { width: 48, height: 36 } as const;
export const MEDIA_SKETCH_CHIP = { width: 68, height: 54 } as const;
/** A box this big or bigger takes the chip at full size: the chip with a margin on every side. */
export const MEDIA_SKETCH_FULL_BOX = { width: 92, height: 76 } as const;
/** In a smaller box the chip shrinks with it, down to this scale; a box that would need less (an avatar, a 34pt row thumbnail) takes none. */
export const MEDIA_SKETCH_MIN_SCALE = 0.6;

/** Share of the cycle spent drawing; then the finished sketch holds, then fades out before the next. */
const DRAW_SHARE = 0.7;
const FADE_START_SHARE = 0.86;
/** How faint the finished sketch gets before the next one starts over it. */
const FADED_OPACITY = 0.12;

function circlePoints(cx: number, cy: number, r: number, segments: number): SketchPoint[] {
  const points: SketchPoint[] = [];
  for (let i = 0; i <= segments; i += 1) {
    // From the top, clockwise, as a hand would draw it.
    const angle = -Math.PI / 2 + (i / segments) * Math.PI * 2;
    points.push({ x: round2(cx + r * Math.cos(angle)), y: round2(cy + r * Math.sin(angle)) });
  }
  return points;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Mountains along a horizon, then the sun above them: the strokes in the order the pencil draws them. */
export const MEDIA_SKETCH_STROKES: readonly SketchStroke[] = [
  [
    { x: 4, y: 31 },
    { x: 15, y: 16 },
    { x: 22, y: 24 },
    { x: 31, y: 11 },
    { x: 44, y: 31 },
  ],
  circlePoints(12, 9, 4, 12),
];

function strokeLength(stroke: SketchStroke) {
  let length = 0;
  for (let i = 1; i < stroke.length; i += 1) {
    length += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  }
  return length;
}

export const MEDIA_SKETCH_STROKE_LENGTHS: readonly number[] = MEDIA_SKETCH_STROKES.map(strokeLength);
export const MEDIA_SKETCH_TOTAL_LENGTH = MEDIA_SKETCH_STROKE_LENGTHS.reduce((sum, length) => sum + length, 0);

/** An SVG path for one stroke. */
export function sketchStrokePath(stroke: SketchStroke): string {
  return stroke.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
}

/**
 * The scale the chip is drawn at in a box this size, or `null` when the box is
 * too small to take it. A creator's 72pt reference thumbnail takes it at about
 * three quarters; a feed tile at full size.
 */
export function mediaSketchScale(width: number, height: number): number | null {
  const scale = Math.min(1, width / MEDIA_SKETCH_FULL_BOX.width, height / MEDIA_SKETCH_FULL_BOX.height);
  return scale >= MEDIA_SKETCH_MIN_SCALE ? scale : null;
}

/**
 * How far along all the strokes the pencil is at `phase` (0 to 1 through the
 * cycle), as a length in drawing units: eased, so the pencil starts and ends
 * each sketch slowly.
 */
export function mediaSketchDrawnLength(phase: number): number {
  'worklet';
  const local = Math.min(1, Math.max(0, phase / DRAW_SHARE));
  const eased = local < 0.5 ? 2 * local * local : 1 - ((-2 * local + 2) ** 2) / 2;
  return eased * MEDIA_SKETCH_TOTAL_LENGTH;
}

/** How much of stroke `index` shows when `drawn` units of the whole sketch are drawn. */
export function mediaSketchStrokeDrawn(drawn: number, index: number): number {
  'worklet';
  let before = 0;
  for (let i = 0; i < index; i += 1) before += MEDIA_SKETCH_STROKE_LENGTHS[i];
  return Math.min(MEDIA_SKETCH_STROKE_LENGTHS[index], Math.max(0, drawn - before));
}

/** The sketch's opacity at `phase`: whole while drawing and holding, then fading before the next. */
export function mediaSketchOpacity(phase: number): number {
  'worklet';
  if (phase <= FADE_START_SHARE) return 1;
  const fade = Math.min(1, (phase - FADE_START_SHARE) / (1 - FADE_START_SHARE));
  return 1 - fade * (1 - FADED_OPACITY);
}

/** The pencil's tip when `drawn` units of the whole sketch are drawn: where the line ends. */
export function mediaSketchTip(drawn: number): SketchPoint {
  'worklet';
  let remaining = Math.max(0, drawn);
  for (let s = 0; s < MEDIA_SKETCH_STROKES.length; s += 1) {
    const stroke = MEDIA_SKETCH_STROKES[s];
    for (let i = 1; i < stroke.length; i += 1) {
      const from = stroke[i - 1];
      const to = stroke[i];
      const segment = Math.hypot(to.x - from.x, to.y - from.y);
      if (remaining <= segment) {
        const t = segment === 0 ? 0 : remaining / segment;
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      }
      remaining -= segment;
    }
  }
  const lastStroke = MEDIA_SKETCH_STROKES[MEDIA_SKETCH_STROKES.length - 1];
  return lastStroke[lastStroke.length - 1];
}
