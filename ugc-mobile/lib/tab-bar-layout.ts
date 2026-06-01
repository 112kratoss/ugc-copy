const CONTENT_BOTTOM_GAP = 20;

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
  const centerSize = isCompact ? 66 : 74;
  const barHeight = isCompact ? 72 : 78;
  const bottomPadding = Math.max(bottomInset, 10);
  const topPadding = Math.round(centerSize * 0.38);

  return {
    isCompact,
    centerSize,
    barHeight,
    centerGap: isCompact ? 70 : 78,
    tabIconSize: isCompact ? 22 : 24,
    tabLabelSize: isCompact ? 10 : 11,
    horizontalPadding: isCompact ? 8 : 12,
    bottomInset,
    bottomPadding,
    topPadding,
    contentBottomPadding: topPadding + barHeight + bottomPadding + CONTENT_BOTTOM_GAP,
  };
}
