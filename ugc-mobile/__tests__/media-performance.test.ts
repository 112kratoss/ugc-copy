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

  it('limits showcase pre-rendering and autoplay to one video', () => {
    expect(HOME_RAIL_DRAW_DISTANCE).toBe(400);
    expect(SHOWCASE_DRAW_DISTANCE).toBe(500);
    expect(SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS).toBe(1);
  });
});
