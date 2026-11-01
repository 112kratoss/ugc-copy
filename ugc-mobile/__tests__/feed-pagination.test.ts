import { describe, expect, it } from 'vitest';

import { canRequestNextFeedPage, nextFeedPageRequestDelay, type FeedPaginationGate } from '../lib/feed-pagination';

const READY_GATE: FeedPaginationGate = {
  cooldownMs: 800,
  hasNextPage: true,
  isBusy: false,
  isRequestInFlight: false,
  lastRequestedAt: 0,
  lastRequestedPageCount: null,
  now: 1_000,
  pageCount: 1,
};

describe('feed pagination gate', () => {
  it('allows a ready feed to request its next page', () => {
    expect(canRequestNextFeedPage(READY_GATE)).toBe(true);
  });

  it('blocks exhausted, busy, in-flight, and cooling-down feeds', () => {
    expect(canRequestNextFeedPage({ ...READY_GATE, hasNextPage: false })).toBe(false);
    expect(canRequestNextFeedPage({ ...READY_GATE, isBusy: true })).toBe(false);
    expect(canRequestNextFeedPage({ ...READY_GATE, isRequestInFlight: true })).toBe(false);
    expect(canRequestNextFeedPage({ ...READY_GATE, lastRequestedAt: 500 })).toBe(false);
  });

  it('blocks another automatic attempt against the same page after an error', () => {
    expect(canRequestNextFeedPage({
      ...READY_GATE,
      lastRequestedPageCount: READY_GATE.pageCount,
      now: 2_000,
    })).toBe(false);
  });

  it('allows pagination after the page count advances even without visible item growth', () => {
    expect(canRequestNextFeedPage({
      ...READY_GATE,
      lastRequestedPageCount: 1,
      pageCount: 2,
      now: 2_000,
    })).toBe(true);
  });

  it('allows an explicit retry when the page lock and cooldown are cleared', () => {
    expect(canRequestNextFeedPage({
      ...READY_GATE,
      lastRequestedAt: 0,
      lastRequestedPageCount: null,
      now: 2_000,
    })).toBe(true);
  });
});

describe('feed pagination wait', () => {
  // Page two was asked for at 1,000, with one page loaded, and has just landed.
  const LANDED_GATE: FeedPaginationGate = {
    ...READY_GATE,
    lastRequestedAt: 1_000,
    lastRequestedPageCount: 1,
    now: 1_400,
    pageCount: 2,
  };

  it('waits out the rest of the cooldown for a page that landed inside it', () => {
    expect(canRequestNextFeedPage(LANDED_GATE)).toBe(false);
    expect(nextFeedPageRequestDelay(LANDED_GATE)).toBe(400);
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, isRequestInFlight: true })).toBe(400);
  });

  it('never waits longer than the cooldown, whatever the clock does', () => {
    // The clock stepped back an hour after the last ask.
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, now: LANDED_GATE.lastRequestedAt - 3_600_000 })).toBe(800);
  });

  it('waits another cooldown for a request that has landed but not settled', () => {
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, isRequestInFlight: true, now: 2_500 })).toBe(800);
  });

  it('waits nothing once the request may go, which is what the gate allows', () => {
    expect(canRequestNextFeedPage({ ...LANDED_GATE, now: 1_800 })).toBe(true);
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, now: 1_800 })).toBe(0);
  });

  it('leaves to a render what renders again as it changes', () => {
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, hasNextPage: false })).toBeNull();
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, isBusy: true })).toBeNull();
    expect(nextFeedPageRequestDelay({ ...LANDED_GATE, isRequestInFlight: true, pageCount: 1 })).toBeNull();
  });
});
