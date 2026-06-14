import { describe, expect, it } from 'vitest';

import { getMagicTabBarMetrics } from '../lib/tab-bar-layout';

describe('magic tab bar layout', () => {
  it('matches the visible tab bar dimensions for regular phones', () => {
    expect(getMagicTabBarMetrics(390, 48)).toMatchObject({
      isCompact: false,
      centerSize: 64,
      barHeight: 66,
      centerGap: 68,
      tabIconSize: 22,
      tabLabelSize: 10,
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
      tabLabelSize: 10,
      horizontalPadding: 10,
      bottomInset: 0,
      bottomPadding: 10,
      topPadding: 20,
      contentBottomPadding: 106,
      contentBottomOverlapPadding: 86,
    });
  });
});
