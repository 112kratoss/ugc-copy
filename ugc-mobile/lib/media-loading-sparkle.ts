/**
 * The loading sparkles: while a clip or a post is on its way to a screen that
 * is still black (the full-screen viewer, a video player), three of the logo's
 * four-pointed sparkles twinkle in turn in place of the spinner, in the
 * sparkle's coral, the booklet's violet and its cream, and fade as the media
 * comes in (`components/media-loading-sparkle.tsx`). The owner chose them on
 * 2026-11-23: "we can go with the sparkle trio . that looks minimal", over a
 * pencil on a dark card ("feels like a big obstruction") and over the logo's
 * one big sparkle bursting as the launch sting does.
 *
 * They wait `MEDIA_SPARKLE_DELAY_MS` first, as the picture sketch does
 * (`lib/media-sketch.ts`): a clip from the cache never flashes them. They
 * shrink with a small box, and a box too small for them keeps the platform's
 * spinner.
 *
 * Pure: no React Native imports, so the timing and geometry can be tested.
 * Functions marked `'worklet'` also run on the UI thread. Times are in
 * milliseconds and lengths in points.
 */
import { MEDIA_SKETCH_DELAY_MS } from './media-sketch';

/** Wait this long after the wait starts before anything is drawn: the picture sketch's wait. */
export const MEDIA_SPARKLE_DELAY_MS = MEDIA_SKETCH_DELAY_MS;
/**
 * Sparkles that start this soon after others went away mid-wait carry
 * straight on with no wait of their own: the viewer's black screen handing
 * over to the post's page while its clip is still coming. The page's own start
 * once the reel has landed, about 350 ms after the black screen went on the
 * Pixel 9a emulator (2026-11-23), so a quarter of a second missed it.
 */
export const MEDIA_SPARKLE_HANDOFF_MS = 1000;

/**
 * The three at full size: each sparkle's size (from its centre to the tip of
 * a point) and the distance between their centres, and their twinkle: each
 * lights for `pulseMs` of every `cycleMs`, `staggerMs` after the one before.
 */
export const MEDIA_SPARKLE_TRIO = { arm: 9, spacing: 23, cycleMs: 1200, pulseMs: 520, staggerMs: 180 } as const;
/** A box this big or bigger takes the three at full size; a smaller one shrinks them with it. */
export const MEDIA_SPARKLE_FULL_BOX = { width: 160, height: 80 } as const;
/** They shrink to this scale at the least; a box that would need less keeps the spinner. */
export const MEDIA_SPARKLE_MIN_SCALE = 0.6;
/** How long they take to fade as the media comes in. */
export const MEDIA_SPARKLE_FADE_MS = 180;

/**
 * The span of the clock they twinkle on before it starts over: far longer
 * than any wait, and a whole number of twinkle cycles, so the loop has no seam.
 */
export const MEDIA_SPARKLE_CLOCK_SPAN_MS = 600_000;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** The scale the three are drawn at in a box this size, or `null` when the box keeps the spinner. */
export function mediaSparkleTrioScale(width: number, height: number): number | null {
  const scale = Math.min(1, width / MEDIA_SPARKLE_FULL_BOX.width, height / MEDIA_SPARKLE_FULL_BOX.height);
  return scale >= MEDIA_SPARKLE_MIN_SCALE ? scale : null;
}

/**
 * The logo's four-pointed sparkle (`assets/images/icon.png`): points up, right,
 * down and left, each side curving in toward the middle. Centred on `(cx, cy)`,
 * by default the middle of a square twice `radius` wide.
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

/** How bright sparkle `index` (0 to 2) is at `time`: 0 between its twinkles, 1 at the top of one. */
export function mediaSparkleTwinkle(time: number, index: number): number {
  'worklet';
  const { cycleMs, pulseMs, staggerMs } = MEDIA_SPARKLE_TRIO;
  const local = ((((time - index * staggerMs) % cycleMs) + cycleMs) % cycleMs) / pulseMs;
  return local >= 1 ? 0 : Math.sin(Math.PI * local);
}

/**
 * How sparkle `index` looks at `time`, `fadeMs` into the fade (negative while
 * the wait lasts): it grows and brightens as it twinkles. Under Reduce Motion
 * it only brightens and dims, in place.
 */
export function mediaSparkleLook(time: number, index: number, fadeMs: number, reducedMotion: boolean) {
  'worklet';
  const twinkle = mediaSparkleTwinkle(time, index);
  const left = fadeMs < 0 ? 1 : Math.max(0, 1 - fadeMs / MEDIA_SPARKLE_FADE_MS);
  return { opacity: (0.3 + 0.7 * twinkle) * left, scale: reducedMotion ? 1 : 0.55 + 0.6 * twinkle };
}
