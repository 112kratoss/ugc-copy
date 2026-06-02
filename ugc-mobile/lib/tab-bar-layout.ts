const CONTENT_BOTTOM_GAP = 14;

export interface MagicTabBarMetrics {
  isCompact: boolean;
  centerSize: number;
  barHeight: number;
  centerGap: number;
  tabIconSize: number;
  tabLabelSize: number;
  horizontalPadding: number;
  bottomInset: number;
  bottomPadding: number;
  topPadding: number;
  contentBottomPadding: number;
}

export function getMagicTabBarMetrics(windowWidth: number, bottomInset: number): MagicTabBarMetrics {
  const isCompact = windowWidth < 380;
  const centerSize = isCompact ? 58 : 64;
  const barHeight = isCompact ? 62 : 66;
  const bottomPadding = Math.max(bottomInset, 10);
  const topPadding = Math.round(centerSize * 0.34);

  return {
    isCompact,
    centerSize,
    barHeight,
    centerGap: isCompact ? 62 : 68,
    tabIconSize: isCompact ? 21 : 22,
    tabLabelSize: 10,
    horizontalPadding: isCompact ? 10 : 14,
    bottomInset,
    bottomPadding,
    topPadding,
    contentBottomPadding: topPadding + barHeight + bottomPadding + CONTENT_BOTTOM_GAP,
  };
}
