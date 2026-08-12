import { describe, expect, it } from 'vitest';

import {
  FEED_WINDOW_MAX_MOUNTED_CARDS,
  getWindowedFeedRange,
} from '@/app/feed/WindowedFeedList';

describe('windowed feed range', () => {
  it('keeps mounted cards bounded in a long variable-height feed', () => {
    const heights = Array.from({ length: 100 }, (_, index) => 280 + (index % 5) * 90);
    const range = getWindowedFeedRange({
      heights,
      gap: 12,
      viewportStart: 18_000,
      viewportHeight: 900,
    });

    expect(range.endIndex - range.startIndex).toBeLessThanOrEqual(FEED_WINDOW_MAX_MOUNTED_CARDS);
    expect(range.startIndex).toBeGreaterThan(0);
    expect(range.endIndex).toBeLessThan(heights.length);
  });

  it('preserves the complete scroll extent with measured offsets', () => {
    const range = getWindowedFeedRange({
      heights: [300, 500, 700],
      gap: 12,
      viewportStart: 0,
      viewportHeight: 800,
      overscan: 0,
    });

    expect(range.offsets).toEqual([0, 312, 824]);
    expect(range.totalHeight).toBe(1_524);
    expect(range).toMatchObject({ startIndex: 0, endIndex: 2 });
  });
});
