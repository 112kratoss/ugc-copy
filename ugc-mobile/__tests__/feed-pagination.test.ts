import { describe, expect, it } from 'vitest';

import { canRequestNextFeedPage, type FeedPaginationGate } from '../lib/feed-pagination';

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
