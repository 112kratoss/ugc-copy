import { describe, expect, it } from 'vitest';

import { mergeShowcaseFeedKeepingVisibleItems } from '@/lib/showcase-feed-stability';

type TestFeedItem = {
  id: string;
  label: string;
  recommendation?: { deliveryId: string };
};

function item(id: string, label = id): TestFeedItem {
  return { id, label };
}

describe('showcase feed stability', () => {
  it('keeps the visible prefix in place and appends ranked items without duplicates', () => {
    const visibleFirst = item('first', 'Visible first');
    const visibleSecond = item('second', 'Visible second');
    const incomingFirst = item('ranked-first');
    const incomingSecond = item('first', 'Incoming duplicate');
    const incomingThird = item('ranked-third');

    const merged = mergeShowcaseFeedKeepingVisibleItems(
      [visibleFirst, visibleSecond, item('not-rendered')],
      [incomingFirst, incomingSecond, incomingThird],
      2,
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      'first',
      'second',
      'ranked-first',
      'ranked-third',
    ]);
    // A visible card the incoming page also holds takes the incoming copy in
    // its place; one the page lacks stays the object it was.
    expect(merged[0]).toBe(incomingSecond);
    expect(merged[1]).toBe(visibleSecond);
  });

  // A card drawn from the page built for everyone has no delivery. The
  // viewer's own page carries one for the same post, and the card only reports
  // its impression, open and share with it.
  it("gives a visible card the incoming page's delivery without moving it", () => {
    const drawnWithoutDelivery = item('drawn');
    const drawnTheRankedPageLacks = item('drawn-only');
    const rankedCopy: TestFeedItem = { ...item('drawn', 'Ranked copy'), recommendation: { deliveryId: 'delivery-7' } };

    const merged = mergeShowcaseFeedKeepingVisibleItems(
      [drawnWithoutDelivery, drawnTheRankedPageLacks],
      [item('ranked-first'), rankedCopy],
      2,
    );

    expect(merged.map((candidate) => candidate.id)).toEqual(['drawn', 'drawn-only', 'ranked-first']);
    expect(merged[0].recommendation).toEqual({ deliveryId: 'delivery-7' });
    expect(merged[0]).toBe(rankedCopy);
    expect(merged[1]).toBe(drawnTheRankedPageLacks);
  });

  it('takes the first incoming copy when the incoming page repeats a visible post', () => {
    const firstCopy = item('drawn', 'First copy');

    const merged = mergeShowcaseFeedKeepingVisibleItems(
      [item('drawn', 'Drawn')],
      [firstCopy, item('drawn', 'Second copy')],
      1,
    );

    expect(merged).toEqual([firstCopy]);
    expect(merged[0]).toBe(firstCopy);
  });

  it('uses the incoming order when no current cards are visible', () => {
    const merged = mergeShowcaseFeedKeepingVisibleItems(
      [item('server-fallback')],
      [item('ranked-first'), item('ranked-second')],
      0,
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      'ranked-first',
      'ranked-second',
    ]);
  });

  it('bounds the visible count and removes duplicate incoming items', () => {
    const merged = mergeShowcaseFeedKeepingVisibleItems(
      [item('visible')],
      [item('ranked'), item('ranked', 'Duplicate ranked')],
      99,
    );

    expect(merged.map((candidate) => candidate.id)).toEqual(['visible', 'ranked']);
  });
});
