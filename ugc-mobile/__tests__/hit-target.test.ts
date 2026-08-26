import { describe, expect, it } from 'vitest';

import { MIN_HIT_TARGET_PT, verticalHitSlop } from '../lib/hit-target';

describe('vertical hit slop', () => {
  it('adds nothing to a control that already clears the minimum', () => {
    expect(verticalHitSlop(MIN_HIT_TARGET_PT)).toEqual({ top: 0, bottom: 0 });
    expect(verticalHitSlop(60)).toEqual({ top: 0, bottom: 0 });
  });

  it('splits the shortfall evenly so the reach stays centred on the control', () => {
    expect(verticalHitSlop(32)).toEqual({ top: 6, bottom: 6 });
  });

  it('rounds up rather than leaving the region a fraction short', () => {
    // 44 - 35 = 9, which does not halve evenly.
    expect(verticalHitSlop(35)).toEqual({ top: 5, bottom: 5 });
  });

  it('lifts every real creator-row height to the minimum', () => {
    for (const height of [32, 34, 36]) {
      const slop = verticalHitSlop(height);
      expect(height + slop.top + slop.bottom).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    }
  });

  it('treats a NaN height as zero rather than returning a NaN slop', () => {
    // React Native reads a NaN slop as no slop, which would hide the bug.
    expect(verticalHitSlop(Number.NaN)).toEqual({ top: 22, bottom: 22 });
  });

  it('ignores a negative height instead of shrinking the region', () => {
    expect(verticalHitSlop(-10)).toEqual({ top: 22, bottom: 22 });
  });
});
