import { easedFade } from './eased-fade';

/**
 * The immersive viewer draws its top controls from two different components —
 * the reel screen owns Back, the mute toggle and the refresh spinner, while
 * each slide owns its own media counter — so the two cannot see each other's
 * frames. Before this module they collided: the counter sat at a hard-coded
 * `top: 68` (no safe area at all) and the refresh spinner at `topInset + 24`,
 * which overlap on every device whose top inset is more than 34pt.
 *
 * Every offset in the viewer's top strip is derived here instead, from the
 * resolved safe-area inset, so HIG *Layout*'s "make sure essential content
 * fits within the safe area" holds and `hig-full-screen.test.ts` can prove the
 * two rows do not overlap without rendering anything.
 */

/** Gap between the safe-area inset and the first row of controls. */
export const VIEWER_TOP_CONTROL_OFFSET = 10;
/** Back and mute are 48pt targets — the app's touch floor (`lib/hit-target`). */
export const VIEWER_TOP_CONTROL_SIZE = 48;
/** Breathing room between the control row and the badge row beneath it. */
export const VIEWER_TOP_ROW_GAP = 8;

/** Top edge of the control row: Back on the leading side, mute on the trailing. */
export function viewerTopControlTop(topInset: number) {
  return topInset + VIEWER_TOP_CONTROL_OFFSET;
}

/** Top edge of the badge row: the media counter, and the reel's refresh spinner. */
export function viewerTopBadgeTop(topInset: number) {
  return viewerTopControlTop(topInset) + VIEWER_TOP_CONTROL_SIZE + VIEWER_TOP_ROW_GAP;
}

// ---------------------------------------------------------------------------
// The shade behind the top strip
// ---------------------------------------------------------------------------

/**
 * How far down the inset the status bar draws its glyphs. The clock and icons
 * sit in roughly the middle of the inset — measured at 27–40pt of a 72pt inset
 * on an iPhone 17 Pro — and this band has to stay dark on a white photo.
 */
export const VIEWER_TOP_SCRIM_GLYPH_BAND = 0.6;
/** Opacity at the very top edge. */
export const VIEWER_TOP_SCRIM_TOP_ALPHA = 0.9;
/**
 * Opacity at the bottom of the glyph band, where the fade begins. 0.84 keeps
 * white glyphs at 4.5:1 or better over pure white, which
 * `hig-full-screen.test.ts` checks across the whole band.
 */
export const VIEWER_TOP_SCRIM_GLYPH_ALPHA = 0.84;
/** How far below the control row the fade runs out. */
export const VIEWER_TOP_SCRIM_TAIL = 24;

export interface ScrimStop {
  /** Distance from the top of the shade, in points. */
  offset: number;
  alpha: number;
}

/**
 * The reel's top shade. It used to be solid for 60% of the inset and then fade
 * in a straight line over the rest — measured on a phone as a black bar, a
 * short ramp and a kink. Now it holds just dark enough over the status bar's
 * glyphs, then eases out through the control row and a little beyond, so it
 * reads as shade rather than as a strip.
 */
export function viewerTopScrim(topInset: number): { height: number; stops: ScrimStop[] } {
  const height = viewerTopControlTop(topInset) + VIEWER_TOP_CONTROL_SIZE + VIEWER_TOP_SCRIM_TAIL;
  const fadeFrom = topInset * VIEWER_TOP_SCRIM_GLYPH_BAND;
  const fadeLength = height - fadeFrom;
  return {
    height,
    stops: [
      { offset: 0, alpha: VIEWER_TOP_SCRIM_TOP_ALPHA },
      // Eased rather than straight: a short straight fade reads as a bar with a
      // kink at its end (lib/eased-fade.ts).
      ...easedFade(VIEWER_TOP_SCRIM_GLYPH_ALPHA).map(({ at, alpha }) => ({
        offset: fadeFrom + at * fadeLength,
        alpha,
      })),
    ],
  };
}

/** The shade's opacity `y` points down, interpolated between stops as a gradient draws it. */
export function scrimAlphaAt(stops: readonly ScrimStop[], y: number): number {
  if (stops.length === 0) return 0;
  if (y <= stops[0].offset) return stops[0].alpha;
  for (let index = 1; index < stops.length; index += 1) {
    const next = stops[index];
    if (y > next.offset) continue;
    const previous = stops[index - 1];
    const span = next.offset - previous.offset;
    if (span <= 0) return next.alpha;
    return previous.alpha + (next.alpha - previous.alpha) * ((y - previous.offset) / span);
  }
  return stops[stops.length - 1].alpha;
}
