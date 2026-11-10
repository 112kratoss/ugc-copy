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
  contentBottomOverlapPadding: number;
}

/**
 * The tab bar as a picture flying home into a tile under it has to know it
 * (lib/apple-zoom-surface.ts): how far up from the bottom of the screen its
 * capsule reaches, and the Create button standing up out of its middle.
 *
 * From the window and the inset, not from a screen's own metrics object: a
 * screen that handed that object to a call lost React Compiler, which could
 * no longer keep the memos that read the object's fields.
 */
export function magicTabBarCover(windowWidth: number, bottomInset: number) {
  const metrics = getMagicTabBarMetrics(windowWidth, bottomInset);
  return {
    height: metrics.barHeight + metrics.bottomPadding,
    capWidth: metrics.centerSize,
    capHeight: metrics.topPadding,
  };
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
    // 11pt is Apple's minimum iOS type size; the tab bar shows it everywhere.
    tabLabelSize: 11,
    horizontalPadding: isCompact ? 10 : 14,
    bottomInset,
    bottomPadding,
    topPadding,
    contentBottomPadding: topPadding + barHeight + bottomPadding + CONTENT_BOTTOM_GAP,
    contentBottomOverlapPadding: barHeight + bottomPadding + CONTENT_BOTTOM_GAP,
  };
}
