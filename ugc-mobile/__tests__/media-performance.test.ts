import { describe, expect, it } from 'vitest';

import {
  IMMERSIVE_HORIZONTAL_LIST_TUNING,
  IMMERSIVE_DETAILS_PRESENTATION,
  HOME_RAIL_DRAW_DISTANCE,
  IMMERSIVE_VERTICAL_LIST_TUNING,
  SHOWCASE_DRAW_DISTANCE,
  SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS,
} from '../lib/media-performance';

describe('mobile media performance configuration', () => {
  it('keeps immersive viewer windows intentionally small', () => {
    expect(IMMERSIVE_DETAILS_PRESENTATION).toBe('sheet');
    expect(IMMERSIVE_VERTICAL_LIST_TUNING).toEqual({
      initialNumToRender: 1,
      maxToRenderPerBatch: 2,
      windowSize: 3,
    });
    expect(IMMERSIVE_HORIZONTAL_LIST_TUNING).toEqual({
      initialNumToRender: 1,
      maxToRenderPerBatch: 2,
      windowSize: 3,
    });
  });

  it('stages showcase cells ahead of the scroll while keeping autoplay at one video', () => {
    expect(HOME_RAIL_DRAW_DISTANCE).toBe(400);
    // Three to four masonry rows, so a flick does not outrun the mounted cells.
    expect(SHOWCASE_DRAW_DISTANCE).toBe(900);
    // Draw distance must not widen autoplay: that stays viewability-capped.
    expect(SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS).toBe(1);
  });
});
