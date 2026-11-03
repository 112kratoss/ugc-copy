import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FEED_LANDING_BUDGET_MS,
  INITIAL_FEED_LANDING,
  feedLandingCardPlace,
  feedLandingScrollArrived,
  initialFeedLanding,
  reduceFeedLanding,
  shouldScrollToFeedTarget,
  type FeedLanding,
  type FeedLandingEvent,
} from '../lib/profile-feed-card-view-model';

function run(events: FeedLandingEvent[], from: FeedLanding = INITIAL_FEED_LANDING) {
  return events.reduce(reduceFeedLanding, from);
}

describe('feed landing', () => {
  it.each([1, 6, 24, 25, 48, 49, 100])('seeks card %i and lands after its native scroll completes', (index) => {
    const seeking = run([{ type: 'target', index, now: 0 }]);
    expect(seeking).toEqual({ phase: 'seeking', targetIndex: index, startedAt: 0, attempt: 0 });
    expect(shouldScrollToFeedTarget(seeking, 200)).toBe(true);

    const glimpsed = reduceFeedLanding(seeking, { type: 'viewable', targetVisible: true });
    expect(glimpsed.phase).toBe('seeking');

    const landed = reduceFeedLanding(glimpsed, {
      type: 'scroll-complete', index, targetVisible: true,
    });
    expect(landed.phase).toBe('landed');
    expect(shouldScrollToFeedTarget(landed, 200)).toBe(false);
  });

  it('lands the first card from viewability because it needs no programmatic scroll', () => {
    const seeking = run([{ type: 'target', index: 0, now: 0 }]);
    const landed = reduceFeedLanding(seeking, { type: 'viewable', targetVisible: true });

    expect(landed.phase).toBe('landed');
    expect(shouldScrollToFeedTarget(landed, 18)).toBe(false);
  });

  it('ignores completion from a stale scroll after the target index changes', () => {
    const seeking = run([
      { type: 'target', index: 6, now: 0 },
      { type: 'target', index: 8, now: 50 },
    ]);

    expect(reduceFeedLanding(seeking, {
      type: 'scroll-complete', index: 6, targetVisible: true,
    })).toBe(seeking);
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
      { type: 'scroll-complete', index: 6, targetVisible: true },
    ]);

    // A refresh inserted two creations above the card being looked at.
    const relanding = reduceFeedLanding(landed, { type: 'target', index: 8, now: 500 });
    expect(relanding).toEqual({ phase: 'seeking', targetIndex: 8, startedAt: 500, attempt: 0 });
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
    expect(retried).toEqual({ phase: 'seeking', targetIndex: 49, startedAt: 9000, attempt: 0 });
  });

  it('requests another scroll on every tick while variable-height cards are still settling', () => {
    const seeking = reduceFeedLanding(INITIAL_FEED_LANDING, { type: 'target', index: 9, now: 0 });
    const secondAttempt = reduceFeedLanding(seeking, { type: 'tick', now: 250 });
    const thirdAttempt = reduceFeedLanding(secondAttempt, { type: 'tick', now: 500 });

    expect(secondAttempt).toMatchObject({ phase: 'seeking', targetIndex: 9, attempt: 1 });
    expect(thirdAttempt).toMatchObject({ phase: 'seeking', targetIndex: 9, attempt: 2 });
    expect(shouldScrollToFeedTarget(thirdAttempt, 24)).toBe(true);
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
    const seeking: FeedLanding = { phase: 'seeking', targetIndex: 13, startedAt: 0, attempt: 0 };
    // FlashList clamps an out-of-range index to the end of the list.
    expect(shouldScrollToFeedTarget(seeking, 13)).toBe(false);
    expect(shouldScrollToFeedTarget({ ...seeking, targetIndex: 0 }, 13)).toBe(false);
  });
});

describe('opening the feed on the tapped card', () => {
  it('seeks a card already in the list from the first render', () => {
    expect(initialFeedLanding(5)).toEqual({ phase: 'seeking', targetIndex: 5, startedAt: null, attempt: 0 });
    expect(initialFeedLanding(0)).toMatchObject({ phase: 'seeking', targetIndex: 0 });
    // Not loaded yet: the screen reports the card when it arrives, as before.
    expect(initialFeedLanding(-1)).toBe(INITIAL_FEED_LANDING);
  });

  it('is not started again when the screen reports the card it began with', () => {
    const first = initialFeedLanding(5);
    expect(reduceFeedLanding(first, { type: 'target', index: 5, now: 40 })).toBe(first);
  });

  it('starts its budget at the first tick and still fails when the budget runs out', () => {
    const started = reduceFeedLanding(initialFeedLanding(5), { type: 'tick', now: 250 });
    expect(started).toMatchObject({ phase: 'seeking', startedAt: 250, attempt: 0 });

    const retried = reduceFeedLanding(started, { type: 'tick', now: 500 });
    expect(retried).toMatchObject({ phase: 'seeking', attempt: 1 });
    expect(reduceFeedLanding(retried, { type: 'tick', now: 250 + FEED_LANDING_BUDGET_MS }).phase).toBe('failed');
  });

  it('lands on the native scroll that brings the card up', () => {
    const landed = reduceFeedLanding(initialFeedLanding(5), { type: 'scroll-complete', index: 5, targetVisible: true });
    expect(landed.phase).toBe('landed');
  });
});

describe("the landing scroll's arrival", () => {
  it('counts the native list standing at the card as arrived, to the pixel', () => {
    expect(feedLandingScrollArrived(1824.4, 1824)).toBe(true);
    expect(feedLandingScrollArrived(1823.5, 1824)).toBe(true);
    expect(feedLandingScrollArrived(1822.9, 1824)).toBe(false);
    // FlashList's steps render ahead without moving the native list.
    expect(feedLandingScrollArrived(0, 1824)).toBe(false);
  });

  it('is what the feed shows from', () => {
    const feed = readFileSync('components/profile-media-feed.tsx', 'utf8');
    expect(feed).toContain('useReducer(reduceFeedLanding, targetIndex, initialFeedLanding)');
    // On iOS; Android keeps the promise until the early reveal has been watched there.
    expect(feed).toContain("onScroll={Platform.OS === 'ios' ? (event) => noteLandingScroll(event.nativeEvent.contentOffset.y) : undefined}");
    // Never `initialScrollIndex`: on Android it overlapped the cards (FlashList #1797,
    // docs/audits/creations-feed-landing-fix-2026-09-16.md).
    expect(feed).not.toContain('initialScrollIndex=');
  });
});

// The feed draws the opened card here while the list is hidden seeking it, so
// a wrong answer is a card that jumps as the list takes over.
describe('where the opened card stands once landed', () => {
  it('keeps the first card under the list’s top padding, since nothing scrolls to it', () => {
    expect(feedLandingCardPlace(0, 1)).toBe('padded');
    expect(feedLandingCardPlace(0, 30)).toBe('padded');
  });

  it('puts any later card at the top of the list, its padding scrolled away', () => {
    expect(feedLandingCardPlace(1, 30)).toBe('top');
    expect(feedLandingCardPlace(28, 30)).toBe('top');
  });

  it('stands the last card on the list’s foot, where FlashList stops the scroll', () => {
    expect(feedLandingCardPlace(29, 30)).toBe('end');
    expect(feedLandingCardPlace(1, 2)).toBe('end');
  });
});
