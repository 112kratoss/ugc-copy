import { describe, expect, it } from 'vitest';

import {
  VIEW_COUNT_TOTAL_LABEL,
  formatCompactViewCount,
  isViewCountShown,
  postViewCountLabels,
  viewCountLabels,
} from '../../ugc-mobile/lib/view-count/view-count';

describe('formatCompactViewCount', () => {
  it('draws 1 to 999 as they are', () => {
    expect(formatCompactViewCount(1)).toBe('1');
    expect(formatCompactViewCount(42)).toBe('42');
    expect(formatCompactViewCount(999)).toBe('999');
  });

  it('draws one decimal below 10 of a unit and none from 10', () => {
    expect(formatCompactViewCount(1_000)).toBe('1K');
    expect(formatCompactViewCount(1_049)).toBe('1K');
    expect(formatCompactViewCount(1_234)).toBe('1.2K');
    expect(formatCompactViewCount(9_949)).toBe('9.9K');
    expect(formatCompactViewCount(12_345)).toBe('12K');
    expect(formatCompactViewCount(123_456)).toBe('123K');
    expect(formatCompactViewCount(1_234_567)).toBe('1.2M');
    expect(formatCompactViewCount(12_345_678)).toBe('12M');
    expect(formatCompactViewCount(2_400_000_000)).toBe('2.4B');
  });

  it('rounds half up, exactly, at every step', () => {
    expect(formatCompactViewCount(1_050)).toBe('1.1K');
    expect(formatCompactViewCount(1_150)).toBe('1.2K');
    expect(formatCompactViewCount(1_250)).toBe('1.3K');
    expect(formatCompactViewCount(12_500)).toBe('13K');
    expect(formatCompactViewCount(1_050_000)).toBe('1.1M');
  });

  it('rounds before it picks the unit, so a figure never reads 10.0K or 1000K', () => {
    expect(formatCompactViewCount(9_950)).toBe('10K');
    expect(formatCompactViewCount(99_999)).toBe('100K');
    expect(formatCompactViewCount(999_499)).toBe('999K');
    expect(formatCompactViewCount(999_500)).toBe('1M');
    expect(formatCompactViewCount(999_950)).toBe('1M');
    expect(formatCompactViewCount(9_960_000)).toBe('10M');
    expect(formatCompactViewCount(999_999_999)).toBe('1B');
  });

  it('keeps billions as its last unit', () => {
    expect(formatCompactViewCount(1_234_000_000_000)).toBe('1234B');
  });

  it('reads anything that is not a count as 0, and a fraction by its whole number', () => {
    expect(formatCompactViewCount(0)).toBe('0');
    expect(formatCompactViewCount(-5)).toBe('0');
    expect(formatCompactViewCount(Number.NaN)).toBe('0');
    expect(formatCompactViewCount(null)).toBe('0');
    expect(formatCompactViewCount(999.9)).toBe('999');
  });

  it('never draws a unit beside a figure of 1,000 or more of it, for any count', () => {
    for (let count = 1; count < 3_000_000; count += 997) {
      const figure = formatCompactViewCount(count);
      const match = /^(\d+)(?:\.(\d))?([KMB]?)$/.exec(figure);
      expect(match, `${count} → ${figure}`).not.toBeNull();
      const [, whole, tenth, unit] = match!;
      if (unit) {
        expect(Number(whole), `${count} → ${figure}`).toBeLessThan(1_000);
        // A decimal only below 10 of the unit, and never a trailing .0.
        if (tenth !== undefined) {
          expect(Number(whole), `${count} → ${figure}`).toBeLessThan(10);
          expect(tenth, `${count} → ${figure}`).not.toBe('0');
        }
      }
    }
  });
});

describe('viewCountLabels', () => {
  it('draws nothing at 0, and for anything that is not a count', () => {
    expect(viewCountLabels(0)).toBeNull();
    expect(viewCountLabels(-1)).toBeNull();
    expect(viewCountLabels(Number.POSITIVE_INFINITY)).toBeNull();
    expect(viewCountLabels(null)).toBeNull();
    expect(viewCountLabels(undefined)).toBeNull();
  });

  it('says one view in the singular', () => {
    expect(viewCountLabels(1)).toEqual({ count: 1, compact: '1', visible: '1 view', spoken: '1 view' });
  });

  it('gives the compact figure to the eye and the whole number to a screen reader', () => {
    expect(viewCountLabels(1_234)).toEqual({
      count: 1_234,
      compact: '1.2K',
      visible: '1.2K views',
      spoken: '1,234 views',
    });
    expect(viewCountLabels(999_950)).toEqual({
      count: 999_950,
      compact: '1M',
      visible: '1M views',
      spoken: '999,950 views',
    });
    expect(viewCountLabels(1_234_567)?.spoken).toBe('1,234,567 views');
    expect(viewCountLabels(1_000)?.visible).toBe('1K views');
    expect(viewCountLabels(999)?.spoken).toBe('999 views');
  });
});

describe('postViewCountLabels', () => {
  it('draws a public post’s views, and reads a post with no visibility as public', () => {
    expect(postViewCountLabels({ viewCount: 12, visibility: 'public' })?.compact).toBe('12');
    expect(postViewCountLabels({ viewCount: 12 })?.compact).toBe('12');
  });

  it('draws nothing for a post that is not public, whatever its total', () => {
    expect(postViewCountLabels({ viewCount: 12, visibility: 'unlisted' })).toBeNull();
    expect(postViewCountLabels({ viewCount: 12, visibility: 'private' })).toBeNull();
    expect(postViewCountLabels({ viewCount: 12, visibility: null })).toBeNull();
    expect(postViewCountLabels({ viewCount: 12, visibility: 'public', archived: true })).toBeNull();
  });

  it('draws nothing at 0 or for a read that carries no total', () => {
    expect(postViewCountLabels({ viewCount: 0, visibility: 'public' })).toBeNull();
    expect(postViewCountLabels({ visibility: 'public' })).toBeNull();
  });

  it('answers whether a post may show its views at all', () => {
    expect(isViewCountShown({})).toBe(true);
    expect(isViewCountShown({ visibility: 'public' })).toBe(true);
    expect(isViewCountShown({ visibility: 'unlisted' })).toBe(false);
    expect(isViewCountShown({ visibility: 'public', archived: true })).toBe(false);
  });

  it('names the creator page’s total', () => {
    expect(VIEW_COUNT_TOTAL_LABEL).toBe('Views');
  });
});
