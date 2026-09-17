import { describe, expect, it } from 'vitest';

import { easedFade } from '../lib/eased-fade';
import { LETTERBOX_EDGE_ALPHA, LETTERBOX_SEAM_OVERLAP, letterboxBands, mirroredBandPicture } from '../lib/letterbox';
import { mediaRectInScreen } from '../lib/media-zoom-transition';

const SCREEN = { width: 400, height: 800 };

describe('the bands around a contained picture', () => {
  it('puts a tall picture between a band above and a band below', () => {
    const bands = letterboxBands(SCREEN, mediaRectInScreen(SCREEN, 1));

    expect(bands).toEqual([
      { edge: 'top', x: 0, y: 0, width: 400, height: 200 },
      { edge: 'bottom', x: 0, y: 600, width: 400, height: 200 },
    ]);
  });

  it('puts a narrow picture between a band on each side', () => {
    const bands = letterboxBands(SCREEN, mediaRectInScreen(SCREEN, 0.25));

    expect(bands).toEqual([
      { edge: 'left', x: 0, y: 0, width: 100, height: 800 },
      { edge: 'right', x: 300, y: 0, width: 100, height: 800 },
    ]);
  });

  it('leaves no band around a picture of the screen’s own shape', () => {
    expect(letterboxBands(SCREEN, mediaRectInScreen(SCREEN, 0.5))).toEqual([]);
  });

  it('ignores a sub-point gap, which is rounding rather than a band', () => {
    expect(letterboxBands(SCREEN, { x: 0, y: 0.4, width: 400, height: 799.2 })).toEqual([]);
  });
});

describe('the picture a band mirrors', () => {
  // Where a row (or column) of the copy lands, in frame coordinates, once it is
  // flipped about its own centre.
  const flippedY = (copy: ReturnType<typeof mirroredBandPicture>, row: number) => copy.area.y + copy.y + copy.height - row;
  const flippedX = (copy: ReturnType<typeof mirroredBandPicture>, column: number) => copy.area.x + copy.x + copy.width - column;

  it('runs the picture’s top edge on under the picture, past the seam of the band above', () => {
    const media = mediaRectInScreen(SCREEN, 1);
    const [top] = letterboxBands(SCREEN, media);
    const copy = mirroredBandPicture(top, media);

    expect(copy.flip).toBe('vertical');
    // Not stretched: the copy is the picture's own size.
    expect(copy.height).toBe(media.height);
    expect(copy.width).toBe(media.width);
    // The band reaches under the picture, and row 0 lands at the far side of
    // that overlap — so there is never a gap to round open at the seam.
    expect(copy.area.height).toBe(top.height + LETTERBOX_SEAM_OVERLAP);
    expect(flippedY(copy, 0)).toBe(media.y + LETTERBOX_SEAM_OVERLAP);
  });

  it('does the same from the bottom edge for the band below', () => {
    const media = mediaRectInScreen(SCREEN, 1);
    const bottom = letterboxBands(SCREEN, media)[1];
    const copy = mirroredBandPicture(bottom, media);

    expect(copy.area.y).toBe(media.y + media.height - LETTERBOX_SEAM_OVERLAP);
    // The picture's last row lands inside the picture, by the overlap.
    expect(flippedY(copy, copy.height)).toBe(media.y + media.height - LETTERBOX_SEAM_OVERLAP);
  });

  it('does the same from the outer columns for side bands', () => {
    const media = mediaRectInScreen(SCREEN, 0.25);
    const [left, right] = letterboxBands(SCREEN, media);
    const leftCopy = mirroredBandPicture(left, media);
    const rightCopy = mirroredBandPicture(right, media);

    expect(leftCopy.flip).toBe('horizontal');
    expect(flippedX(leftCopy, 0)).toBe(media.x + LETTERBOX_SEAM_OVERLAP);
    expect(flippedX(rightCopy, rightCopy.width)).toBe(media.x + media.width - LETTERBOX_SEAM_OVERLAP);
    expect(leftCopy.height).toBe(media.height);
  });

  it('still fills a band deeper than the picture', () => {
    // A wide picture on a tall screen: each band is deeper than the picture.
    const media = mediaRectInScreen(SCREEN, 4);
    const [top] = letterboxBands(SCREEN, media);
    const copy = mirroredBandPicture(top, media);

    expect(top.height).toBeGreaterThan(media.height);
    expect(copy.height).toBe(copy.area.height);
    expect(copy.y).toBe(0);
    expect(flippedY(copy, 0)).toBe(media.y + LETTERBOX_SEAM_OVERLAP);
  });
});

describe('the shade over a band', () => {
  it('is darkest at the screen edge and gone where the picture begins', () => {
    const fade = easedFade(LETTERBOX_EDGE_ALPHA);

    expect(fade[0]).toEqual({ at: 0, alpha: LETTERBOX_EDGE_ALPHA });
    expect(fade[fade.length - 1]).toEqual({ at: 1, alpha: 0 });
    // It only ever lightens towards the picture: no band inside the band.
    for (let index = 1; index < fade.length; index += 1) {
      expect(fade[index].at).toBeGreaterThan(fade[index - 1].at);
      expect(fade[index].alpha).toBeLessThanOrEqual(fade[index - 1].alpha);
    }
  });
});
