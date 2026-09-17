/**
 * The bands a `contain`-fitted picture leaves inside its frame, and how dark
 * the shade over them gets.
 *
 * The reel fills those bands with a blurred copy of the picture. They used to
 * be dimmed evenly, by 34%, while the picture itself is not dimmed at all — so
 * wherever a band met the picture there was a hard edge: measured as a 49-level
 * jump in a single row on a Pixel 9a and 59 on an iPhone 17 Pro. Now the shade
 * is darkest at the frame edge and eases out to nothing where the picture
 * begins, so the band meets the picture at the picture's own brightness.
 */
import type { ZoomRect, ZoomSize } from './media-zoom-transition';

export interface LetterboxBand {
  /** The frame edge the band lies against — where its shade is darkest. */
  edge: 'top' | 'bottom' | 'left' | 'right';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Shade at a band's frame edge. Darker than the even 34% it replaces, since it has nothing left by the picture. */
export const LETTERBOX_EDGE_ALPHA = 0.55;

/** Below this a gap is rounding, not a band. */
const MIN_BAND = 1;

/**
 * Where a band draws its copy of the picture: flipped outward about the seam, so
 * the row (or column) right against the picture is the picture's own edge row.
 *
 * The band used to show a blurred copy of the whole picture scaled to cover the
 * screen. Just past the picture's edge that copy showed some other part of the
 * picture — a brighter patch of sky, say — which left a step of some 15 levels
 * however the shade was eased. A mirrored copy meets the picture with the
 * picture's own edge, whatever the picture is.
 *
 * The rect is relative to the band, before the flip, which turns the copy about
 * its own centre. A band deeper than the picture is tall (or wide) stretches the
 * copy along that axis so it still fills the band: blurred, the stretch does not
 * show, and the seam row stays the edge row.
 */
export interface MirroredBandPicture {
  /** Where the band draws, relative to the frame: the band, reaching under the picture by the overlap. */
  area: { x: number; y: number; width: number; height: number };
  /** The copy of the picture, relative to `area`, before the flip. */
  x: number;
  y: number;
  width: number;
  height: number;
  flip: 'vertical' | 'horizontal';
}

/**
 * How far a band reaches under the picture. The band's edge and the picture's
 * land on a fractional pixel, and rounding them apart left a one-pixel black
 * line along the seam on a Pixel 9a. Reaching under the picture — which is drawn
 * over the bands — closes any such gap with the band's own copy of the edge.
 */
export const LETTERBOX_SEAM_OVERLAP = 2;

export function mirroredBandPicture(band: LetterboxBand, media: ZoomRect): MirroredBandPicture {
  const overlap = LETTERBOX_SEAM_OVERLAP;
  if (band.edge === 'top' || band.edge === 'bottom') {
    const area = band.edge === 'top'
      ? { x: band.x, y: band.y, width: band.width, height: band.height + overlap }
      : { x: band.x, y: band.y - overlap, width: band.width, height: band.height + overlap };
    const height = Math.max(media.height, area.height);
    return {
      area,
      x: media.x - band.x,
      // Flipped about its centre, the copy's top row ends up at its bottom: a top
      // band puts that bottom at the far side of the overlap, a bottom band puts
      // its top there — so the copy runs on under the picture past the seam.
      y: band.edge === 'top' ? area.height - height : 0,
      width: media.width,
      height,
      flip: 'vertical',
    };
  }
  const area = band.edge === 'left'
    ? { x: band.x, y: band.y, width: band.width + overlap, height: band.height }
    : { x: band.x - overlap, y: band.y, width: band.width + overlap, height: band.height };
  const width = Math.max(media.width, area.width);
  return {
    area,
    x: band.edge === 'left' ? area.width - width : 0,
    y: media.y - band.y,
    width,
    height: media.height,
    flip: 'horizontal',
  };
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
