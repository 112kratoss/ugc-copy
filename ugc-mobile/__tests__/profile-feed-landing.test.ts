import { describe, expect, it } from 'vitest';

import {
  FEED_LANDING_RETRY_DELAYS_MS,
  MAX_FEED_LANDING_ATTEMPTS,
  shouldReassertFeedLanding,
} from '../lib/profile-feed-card-view-model';

function landing(overrides: Partial<Parameters<typeof shouldReassertFeedLanding>[0]> = {}) {
  return shouldReassertFeedLanding({
    targetIndex: 5,
    cardCount: 13,
    landed: false,
    readerTookOver: false,
    attempts: 0,
    ...overrides,
  });
}

describe('shouldReassertFeedLanding', () => {
  it('keeps re-asserting while the target has not come into view', () => {
    expect(landing()).toBe(true);
    expect(landing({ attempts: MAX_FEED_LANDING_ATTEMPTS - 1 })).toBe(true);
  });

  it('stops once the target is on screen', () => {
    expect(landing({ landed: true })).toBe(false);
  });

  it('stops as soon as the reader scrolls, so the list is never yanked back', () => {
    expect(landing({ readerTookOver: true })).toBe(false);
  });

  it('gives up rather than retrying forever when the card never becomes viewable', () => {
    expect(landing({ attempts: MAX_FEED_LANDING_ATTEMPTS })).toBe(false);
  });

  it('does not scroll for the first card, which needs no landing', () => {
    expect(landing({ targetIndex: 0 })).toBe(false);
  });

  /**
   * The regression this whole path exists for: FlashList clamps an out-of-range
   * scroll to the end of the list, so asking for an index the list does not have
   * lands the reader on the oldest card instead of the one they tapped.
   */
  it('refuses an index the list cannot contain instead of clamping to the end', () => {
    expect(landing({ targetIndex: 13, cardCount: 13 })).toBe(false);
    expect(landing({ targetIndex: 99, cardCount: 13 })).toBe(false);
    expect(landing({ targetIndex: 5, cardCount: 0 })).toBe(false);
  });

  it('allows one attempt per scheduled delay plus the immediate one', () => {
    expect(MAX_FEED_LANDING_ATTEMPTS).toBe(FEED_LANDING_RETRY_DELAYS_MS.length + 1);
  });

  it('schedules retries in increasing order so later cards get later chances', () => {
    const sorted = [...FEED_LANDING_RETRY_DELAYS_MS].sort((a, b) => a - b);
    expect(FEED_LANDING_RETRY_DELAYS_MS).toEqual(sorted);
  });
});
