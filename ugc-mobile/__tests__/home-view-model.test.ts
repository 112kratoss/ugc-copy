import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatCompactCount,
  formatRelativeTime,
  formatUsdCents,
} from '../lib/home-view-model';
import { cachedDateTimeFormat, cachedNumberFormat } from '../lib/intl-format-cache';

describe('home view model', () => {
  it('formats compact counts and relative times for dashboard cards', () => {
    const now = new Date('2026-05-13T12:00:00.000Z');

    expect(formatCompactCount(96)).toBe('96');
    expect(formatCompactCount(1200)).toBe('1.2K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatRelativeTime('2026-05-13T11:50:00.000Z', now)).toBe('10m ago');
    expect(formatRelativeTime('2026-05-12T10:00:00.000Z', now)).toBe('1d ago');
    expect(formatUsdCents(4280)).toBe('$42.80');
  });

  // 03-9: "$5" here and "$5.00" on the web for the same amount.
  it('prints dollars with their cents, as the web does', () => {
    expect(formatUsdCents(500)).toBe('$5.00');
    expect(formatUsdCents(10_000)).toBe('$100.00');
    expect(formatUsdCents(123_456)).toBe('$1,234.56');
    expect(formatUsdCents(5)).toBe('$0.05');
    expect(formatUsdCents(0)).toBe('$0.00');
    expect(formatUsdCents(null)).toBe('$0.00');
  });
});

// Device sweep 2026-11-03: a DateTimeFormat built per Alerts row took ~40 ms of
// the list's first render on the Pixel 9a emulator.
describe('kept Intl formatters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dates an old event by month and day, as a formatter built for it would', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    const events = ['2026-08-01T12:00:00.000Z', '2026-07-15T12:00:00.000Z', '2025-12-25T12:00:00.000Z'];

    expect(events.map((value) => formatRelativeTime(value, now))).toEqual(['Aug 1', 'Jul 15', 'Dec 25']);
    expect(events.map((value) => formatRelativeTime(value, now))).toEqual(
      events.map((value) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))),
    );
  });

  it('builds no formatter per call once one is kept', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    // Both kept before counting, whichever test ran first.
    formatRelativeTime('2026-08-01T12:00:00.000Z', now);
    formatUsdCents(100);
    const dateFormats = vi.spyOn(Intl, 'DateTimeFormat');
    const numberFormats = vi.spyOn(Intl, 'NumberFormat');

    for (let day = 1; day <= 20; day += 1) {
      formatRelativeTime(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`, now);
      formatUsdCents(day * 100);
    }

    expect(dateFormats).not.toHaveBeenCalled();
    expect(numberFormats).not.toHaveBeenCalled();
  });

  it('keeps one formatter for each locale and set of options', () => {
    const monthDay = cachedDateTimeFormat('en', { month: 'short', day: 'numeric' });
    expect(cachedDateTimeFormat('en', { month: 'short', day: 'numeric' })).toBe(monthDay);
    expect(cachedDateTimeFormat('en', { month: 'long', day: 'numeric' })).not.toBe(monthDay);
    expect(cachedDateTimeFormat('en-GB', { month: 'short', day: 'numeric' })).not.toBe(monthDay);

    const dollars = cachedNumberFormat('en-US', { style: 'currency', currency: 'USD' });
    expect(cachedNumberFormat('en-US', { style: 'currency', currency: 'USD' })).toBe(dollars);
    expect(cachedNumberFormat('en-US', { style: 'currency', currency: 'EUR' })).not.toBe(dollars);
  });
});
