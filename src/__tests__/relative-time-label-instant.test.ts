import { describe, expect, it } from 'vitest';

import { formatRelativeTime, relativeTimeLabelInstant } from '@/lib/post-feed-presentation';

// A post page drew its age at the moment it was rendered, so every refresh of an
// unchanged post wrote different HTML, and Vercel writes the cache again for any
// change. It draws at the moment its label was last right instead.

const CREATED = '2026-10-01T08:15:42.123Z';
const created = new Date(CREATED).getTime();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function label(at: number) {
  return formatRelativeTime(CREATED, new Date(at));
}

describe('the moment a post page draws its age at', () => {
  it('draws the same label as now, at every age from seconds to years', () => {
    const ages = [
      0, 5 * SECOND, 59 * SECOND, MINUTE, 61 * SECOND, 59 * MINUTE + 59 * SECOND,
      HOUR, HOUR + 1, 23 * HOUR + 59 * MINUTE, DAY, DAY + HOUR, 6 * DAY + 23 * HOUR,
      7 * DAY, 13 * DAY, 29 * DAY, 30 * DAY, 34 * DAY + 23 * HOUR, 35 * DAY, 59 * DAY + 3 * HOUR,
      200 * DAY, 359 * DAY, 362 * DAY, 364 * DAY, 365 * DAY, 800 * DAY + 5 * HOUR,
      // The half second before each band, which the label already rounds up.
      59_500, 59_600, HOUR - 400, DAY - 300, 7 * DAY - 499, 35 * DAY - 400, 360 * DAY - 300,
    ];
    for (const age of ages) {
      const now = created + age;
      const instant = relativeTimeLabelInstant(CREATED, now);
      expect(instant, `age ${age}`).toBeLessThanOrEqual(now + 500);
      expect(label(instant), `age ${age}`).toBe(label(now));
    }
  });

  it('stays the same moment until the label moves, so an unchanged page renders the same', () => {
    // 3h12m and 3h58m both read "3h": one moment for both.
    expect(relativeTimeLabelInstant(CREATED, created + 3 * HOUR + 12 * MINUTE))
      .toBe(relativeTimeLabelInstant(CREATED, created + 3 * HOUR + 58 * MINUTE));
    // 2d1h and 2d23h both read "2d".
    expect(relativeTimeLabelInstant(CREATED, created + 2 * DAY + HOUR))
      .toBe(relativeTimeLabelInstant(CREATED, created + 2 * DAY + 23 * HOUR));
    // 9 and 13 days both read "1w".
    expect(relativeTimeLabelInstant(CREATED, created + 9 * DAY))
      .toBe(relativeTimeLabelInstant(CREATED, created + 13 * DAY));
    // 40 and 59 days both read "1mo"; 181 and 209 days both "6mo"; 400 and 700 days both "1y".
    expect(relativeTimeLabelInstant(CREATED, created + 40 * DAY))
      .toBe(relativeTimeLabelInstant(CREATED, created + 59 * DAY));
    expect(relativeTimeLabelInstant(CREATED, created + 181 * DAY))
      .toBe(relativeTimeLabelInstant(CREATED, created + 209 * DAY + 5 * HOUR));
    expect(relativeTimeLabelInstant(CREATED, created + 400 * DAY))
      .toBe(relativeTimeLabelInstant(CREATED, created + 700 * DAY));
    // And it moves with the label.
    expect(relativeTimeLabelInstant(CREATED, created + 4 * HOUR))
      .not.toBe(relativeTimeLabelInstant(CREATED, created + 3 * HOUR + 58 * MINUTE));
  });

  it('falls back to now for a date it cannot read or one in the future', () => {
    expect(relativeTimeLabelInstant('not a date', 1_000)).toBe(1_000);
    expect(relativeTimeLabelInstant(CREATED, created - 5 * SECOND)).toBe(created - 5 * SECOND);
  });
});
