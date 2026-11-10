import { describe, expect, it } from 'vitest';

import { getMagicTabBarMetrics, magicTabBarCover } from '../lib/tab-bar-layout';

// What a picture flying home into a tile under the tab bar is kept off
// (lib/reel-close-flight.ts): the capsule, and the Create button above it.
describe('the tab bar, to a picture landing under it', () => {
  it('is its capsule up from the foot of the screen, and the Create button standing out of it', () => {
    expect(magicTabBarCover(402, 34)).toEqual({ height: 66 + 34, capWidth: 64, capHeight: 22 });
    // The same bar the screens lay their lists out round.
    const metrics = getMagicTabBarMetrics(402, 34);
    expect(magicTabBarCover(402, 34).height).toBe(metrics.barHeight + metrics.bottomPadding);
  });

  it('follows the bar on a narrow phone and one with no home indicator', () => {
    expect(magicTabBarCover(375, 0)).toEqual({ height: 62 + 10, capWidth: 58, capHeight: 20 });
  });
});
