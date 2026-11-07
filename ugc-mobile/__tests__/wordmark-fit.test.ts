import { describe, expect, it } from 'vitest';

import { fittedWordmarkSize } from '../lib/wordmark-fit';

const base = { fullSize: 30, minSize: 22 };

describe('fittedWordmarkSize', () => {
  it('keeps the full size while the name fits', () => {
    expect(fittedWordmarkSize({ ...base, naturalWidth: 200, availableWidth: 258 })).toBe(30);
    expect(fittedWordmarkSize({ ...base, naturalWidth: 258, availableWidth: 258 })).toBe(30);
  });

  it('scales the name down by as much as the row is short', () => {
    // The welcome header on a 375pt-wide iPhone: 191pt beside the glyph for a name 199pt wide.
    const size = fittedWordmarkSize({ ...base, naturalWidth: 199, availableWidth: 191 });
    expect(size).toBeLessThan(30);
    expect((199 * size) / 30).toBeLessThanOrEqual(191);
    expect(size).toBeCloseTo(28.7, 1);
  });

  it('never draws the name smaller than the compact lockup', () => {
    // A 375pt phone at the largest text size the title role allows.
    expect(fittedWordmarkSize({ ...base, naturalWidth: 400, availableWidth: 190 })).toBe(22);
  });

  it('draws the full size until both widths are known', () => {
    expect(fittedWordmarkSize({ ...base, naturalWidth: 0, availableWidth: 258 })).toBe(30);
    expect(fittedWordmarkSize({ ...base, naturalWidth: 280, availableWidth: 0 })).toBe(30);
    expect(fittedWordmarkSize({ ...base, naturalWidth: 280, availableWidth: -40 })).toBe(30);
    expect(fittedWordmarkSize({ ...base, naturalWidth: Number.NaN, availableWidth: 258 })).toBe(30);
  });
});
