import { describe, expect, it } from 'vitest';

import {
  FEED_LANDING_BUDGET_MS,
  INITIAL_FEED_LANDING,
  reduceFeedLanding,
  shouldScrollToFeedTarget,
  type FeedLanding,
  type FeedLandingEvent,
} from '../lib/profile-feed-card-view-model';

function run(events: FeedLandingEvent[], from: FeedLanding = INITIAL_FEED_LANDING) {
  return events.reduce(reduceFeedLanding, from);
}

describe('feed landing', () => {
  it.each([1, 6, 24, 25, 48, 49, 100])('seeks card %i and lands once it is on screen', (index) => {
    const seeking = run([{ type: 'target', index, now: 0 }]);
    expect(seeking).toEqual({ phase: 'seeking', targetIndex: index, startedAt: 0 });
    expect(shouldScrollToFeedTarget(seeking, 200)).toBe(true);

    const landed = reduceFeedLanding(seeking, { type: 'viewable', targetVisible: true });
    expect(landed.phase).toBe('landed');
    expect(shouldScrollToFeedTarget(landed, 200)).toBe(false);
  });

  it('waits for slow data instead of spending its budget before the card exists', () => {
    // Two seconds of nothing, then the target arrives: the budget starts then.
    const waiting = run([{ type: 'tick', now: 1000 }, { type: 'tick', now: 2000 }]);
    expect(waiting.phase).toBe('waiting');

    const seeking = run([{ type: 'target', index: 24, now: 2000 }, { type: 'tick', now: 4000 }], waiting);
    expect(seeking.phase).toBe('seeking');
  });

  it('lands again when the list reorders before the reader has moved', () => {
    const landed = run([
      { type: 'target', index: 6, now: 0 },
      { type: 'viewable', targetVisible: true },
    ]);

    // A refresh inserted two creations above the card being looked at.
    const relanding = reduceFeedLanding(landed, { type: 'target', index: 8, now: 500 });
    expect(relanding).toEqual({ phase: 'seeking', targetIndex: 8, startedAt: 500 });
    expect(reduceFeedLanding(relanding, { type: 'target', index: 8, now: 600 })).toBe(relanding);
  });

  it('lets the reader\'s own scroll win for the rest of the visit', () => {
    const released = run([
      { type: 'target', index: 6, now: 0 },
      { type: 'reader-scrolled' },
      { type: 'target', index: 9, now: 100 },
      { type: 'retry', now: 200 },
    ]);

    expect(released.phase).toBe('released');
    expect(shouldScrollToFeedTarget(released, 200)).toBe(false);
  });

  it('says it failed when the budget runs out, and can be asked again', () => {
    const failed = run([
      { type: 'target', index: 49, now: 0 },
      { type: 'tick', now: FEED_LANDING_BUDGET_MS - 1 },
      { type: 'tick', now: FEED_LANDING_BUDGET_MS },
    ]);
    expect(failed.phase).toBe('failed');

    const retried = reduceFeedLanding(failed, { type: 'retry', now: 9000 });
    expect(retried).toEqual({ phase: 'seeking', targetIndex: 49, startedAt: 9000 });
  });

  it('goes back to waiting when the card leaves the list, and never falls back to the first card', () => {
    const gone = run([
      { type: 'target', index: 6, now: 0 },
      { type: 'target', index: -1, now: 100 },
    ]);

    expect(gone).toEqual(INITIAL_FEED_LANDING);
    expect(shouldScrollToFeedTarget(gone, 200)).toBe(false);
  });

  it('never scrolls to an index the list does not contain, or for the first card', () => {
    const seeking: FeedLanding = { phase: 'seeking', targetIndex: 13, startedAt: 0 };
    // FlashList clamps an out-of-range index to the end of the list.
    expect(shouldScrollToFeedTarget(seeking, 13)).toBe(false);
    expect(shouldScrollToFeedTarget({ ...seeking, targetIndex: 0 }, 13)).toBe(false);
  });
});
