import { afterEach, describe, expect, it } from 'vitest';

import { reelNeighbourChromeRevealed, setReelNeighbourChromeRevealed } from '../lib/reel-neighbour-chrome';

describe('reel neighbour chrome', () => {
  afterEach(() => {
    setReelNeighbourChromeRevealed(false);
  });

  it('rests hidden, is revealed for a drag and hidden again once it settles', () => {
    expect(reelNeighbourChromeRevealed.get()).toBe(0);
    setReelNeighbourChromeRevealed(true);
    expect(reelNeighbourChromeRevealed.get()).toBe(1);
    setReelNeighbourChromeRevealed(false);
    expect(reelNeighbourChromeRevealed.get()).toBe(0);
  });
});
