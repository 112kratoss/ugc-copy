import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads `Platform.OS` to decide whether a raised Create control has
// to be cleared, and vitest cannot parse react-native's own entry point, so the
// platform is a flippable double rather than a real import.
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));

import { getMagicTabBarMetrics } from '../lib/tab-bar-layout';

describe('magic tab bar layout', () => {
  beforeEach(() => {
    platform.os = 'ios';
  });

  it('matches the visible tab bar dimensions for regular phones', () => {
    expect(getMagicTabBarMetrics(390, 48)).toMatchObject({
      isCompact: false,
      centerSize: 64,
      barHeight: 66,
      centerGap: 68,
      tabIconSize: 22,
      // Apple's minimum iOS type size; the bar shows it on every screen.
      tabLabelSize: 11,
      horizontalPadding: 14,
      bottomInset: 48,
      bottomPadding: 48,
      topPadding: 22,
      contentBottomPadding: 150,
      contentBottomOverlapPadding: 128,
    });
  });

  it('keeps a minimum bottom gap on compact layouts without a reported inset', () => {
    expect(getMagicTabBarMetrics(360, 0)).toMatchObject({
      isCompact: true,
      centerSize: 58,
      barHeight: 62,
      centerGap: 62,
      tabIconSize: 21,
      // Apple's minimum iOS type size; the bar shows it on every screen.
      tabLabelSize: 11,
      horizontalPadding: 10,
      bottomInset: 0,
      bottomPadding: 10,
      topPadding: 20,
      contentBottomPadding: 106,
      contentBottomOverlapPadding: 86,
    });
  });

  /**
   * Android's dock carries Create inline, so nothing sits above the bar and the
   * reserve every screen keeps is exactly the bar. The two content paddings
   * converging is the assertion: a screen that reserved the iOS overhang left a
   * band of dead space above the dock.
   */
  it('reserves nothing for a raised control Android does not draw', () => {
    platform.os = 'android';

    expect(getMagicTabBarMetrics(390, 48)).toMatchObject({
      barHeight: 66,
      bottomPadding: 48,
      topPadding: 0,
      contentBottomPadding: 128,
      contentBottomOverlapPadding: 128,
    });
    expect(getMagicTabBarMetrics(360, 0)).toMatchObject({
      barHeight: 62,
      bottomPadding: 10,
      topPadding: 0,
      contentBottomPadding: 86,
      contentBottomOverlapPadding: 86,
    });
  });
});
