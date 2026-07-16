import { describe, expect, it } from 'vitest';

import { mergeShowcaseFeedKeepingVisibleItems } from '@/lib/showcase-feed-stability';

type TestFeedItem = {
  id: string;
  label: string;
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
    expect(merged[0]).toBe(visibleFirst);
    expect(merged[1]).toBe(visibleSecond);
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
