import { describe, expect, it } from 'vitest';

import { bandArea, LETTERBOX_SEAM_OVERLAP, letterboxBands } from '../lib/letterbox';
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

describe('where a band draws', () => {
  it('reaches under the picture by the seam overlap above and below it', () => {
    const media = mediaRectInScreen(SCREEN, 1);
    const [top, bottom] = letterboxBands(SCREEN, media).map(bandArea);

    expect(top).toEqual({ x: 0, y: 0, width: 400, height: 200 + LETTERBOX_SEAM_OVERLAP });
    expect(bottom).toEqual({ x: 0, y: 600 - LETTERBOX_SEAM_OVERLAP, width: 400, height: 200 + LETTERBOX_SEAM_OVERLAP });
    // Both run on past the seam, into the picture, so rounding cannot open a gap.
    expect(top.y + top.height).toBe(media.y + LETTERBOX_SEAM_OVERLAP);
    expect(bottom.y).toBe(media.y + media.height - LETTERBOX_SEAM_OVERLAP);
  });

  it('does the same either side of a narrow picture', () => {
    const media = mediaRectInScreen(SCREEN, 0.25);
    const [left, right] = letterboxBands(SCREEN, media).map(bandArea);

    expect(left).toEqual({ x: 0, y: 0, width: 100 + LETTERBOX_SEAM_OVERLAP, height: 800 });
    expect(right).toEqual({ x: 300 - LETTERBOX_SEAM_OVERLAP, y: 0, width: 100 + LETTERBOX_SEAM_OVERLAP, height: 800 });
  });
});
