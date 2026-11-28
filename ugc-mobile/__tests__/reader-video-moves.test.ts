import { describe, expect, it } from 'vitest';

import { createReaderMoveFilter, markVideoMovedByReader, wasVideoMovedByReader } from '@/lib/reader-video-moves';

describe('a clip the reader moved by hand', () => {
  it('passes every report of a clip nobody moved', () => {
    const player = {};
    const admits = createReaderMoveFilter(player);
    expect([0, 0.25, 0.5, 4, 0.1].map(admits)).toEqual([true, true, true, true, true]);
  });

  it('holds back a Home tile’s reports after a reel closes into it from a scrubbed place, until the clip starts over', () => {
    const player = {};
    markVideoMovedByReader(player);
    expect(wasVideoMovedByReader(player)).toBe(true);
    const admits = createReaderMoveFilter(player);
    // The tile plays on from 9.5 s, where the reader dragged to: not watched here.
    expect([9.5, 9.75, 10, 11.75].map(admits)).toEqual([false, false, false, false]);
    // The clip starts over: from here the tile's reports are what was played.
    expect(admits(0.1)).toBe(true);
    expect(wasVideoMovedByReader(player)).toBe(false);
    expect([0.35, 0.6].map(admits)).toEqual([true, true]);
  });

  it('marks one player, not every other', () => {
    const moved = {};
    const other = {};
    markVideoMovedByReader(moved);
    expect(createReaderMoveFilter(other)(5)).toBe(true);
  });

  it('holds back from the first report when the tile takes the player over mid-clip', () => {
    const player = {};
    markVideoMovedByReader(player);
    expect(createReaderMoveFilter(player)(3)).toBe(false);
  });
});
