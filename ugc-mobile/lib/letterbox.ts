/**
 * The bands a `contain`-fitted picture leaves inside its frame. The reel fills
 * them with plain black, as a video player does (`components/letterbox-bands.tsx`).
 */
import type { ZoomRect, ZoomSize } from './media-zoom-transition';

export interface LetterboxBand {
  /** The frame edge the band lies against. */
  edge: 'top' | 'bottom' | 'left' | 'right';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this a gap is rounding, not a band. */
const MIN_BAND = 1;

/**
 * How far a band reaches under the picture. The band's edge and the picture's
 * land on a fractional pixel, and rounding them apart left a one-pixel line
 * along the seam on a Pixel 9a. Reaching under the picture — which is drawn
 * over the bands — closes any such gap.
 */
export const LETTERBOX_SEAM_OVERLAP = 2;

/** Where a band draws, relative to the frame: the band, reaching under the picture by the overlap. */
export function bandArea(band: LetterboxBand): { x: number; y: number; width: number; height: number } {
  const overlap = LETTERBOX_SEAM_OVERLAP;
  switch (band.edge) {
    case 'top':
      return { x: band.x, y: band.y, width: band.width, height: band.height + overlap };
    case 'bottom':
      return { x: band.x, y: band.y - overlap, width: band.width, height: band.height + overlap };
    case 'left':
      return { x: band.x, y: band.y, width: band.width + overlap, height: band.height };
    case 'right':
      return { x: band.x - overlap, y: band.y, width: band.width + overlap, height: band.height };
  }
}

export function letterboxBands(frame: ZoomSize, media: ZoomRect): LetterboxBand[] {
  const bands: LetterboxBand[] = [];
  const bottom = frame.height - (media.y + media.height);
  const right = frame.width - (media.x + media.width);
  if (media.y >= MIN_BAND) bands.push({ edge: 'top', x: 0, y: 0, width: frame.width, height: media.y });
  if (bottom >= MIN_BAND) {
    bands.push({ edge: 'bottom', x: 0, y: media.y + media.height, width: frame.width, height: bottom });
  }
  if (media.x >= MIN_BAND) bands.push({ edge: 'left', x: 0, y: 0, width: media.x, height: frame.height });
  if (right >= MIN_BAND) {
    bands.push({ edge: 'right', x: media.x + media.width, y: 0, width: right, height: frame.height });
  }
  return bands;
}
