import { describe, expect, it } from 'vitest';

import { isLeftEdgeOpenSwipe } from '../lib/edge-swipe-menu';

describe('isLeftEdgeOpenSwipe', () => {
  it('opens only for a clear rightward swipe from the left edge', () => {
    expect(isLeftEdgeOpenSwipe({ x0: 18, dx: 72, dy: 12 })).toBe(true);
  });

  it('ignores swipes that start away from the edge', () => {
    expect(isLeftEdgeOpenSwipe({ x0: 42, dx: 90, dy: 4 })).toBe(true);
    expect(isLeftEdgeOpenSwipe({ x0: 118, dx: 90, dy: 4 })).toBe(false);
  });

  it('ignores vertical scrolling and short horizontal movement', () => {
    expect(isLeftEdgeOpenSwipe({ x0: 12, dx: 42, dy: 3 })).toBe(false);
    expect(isLeftEdgeOpenSwipe({ x0: 12, dx: 80, dy: 58 })).toBe(false);
  });
});
