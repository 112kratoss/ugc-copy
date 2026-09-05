import { Platform } from 'react-native';

const CONTENT_BOTTOM_GAP = 14;

/**
 * Only iOS raises the Create control above the bar. Android draws it inline in
 * the dock, so the overhang the raised disc needs — and the matching reserve
 * every screen inside the tabs keeps for it — is zero there. Deriving that here
 * rather than at each call site is what stops one screen keeping the gap after
 * the others lose it.
 *
 * Read per call rather than once at import: the value is a single property
 * lookup, and pinning both geometries in one test file is worth more than the
 * constant.
 */
function hasRaisedCenter() {
  return Platform.OS !== 'android';
}

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

export function getMagicTabBarMetrics(windowWidth: number, bottomInset: number): MagicTabBarMetrics {
  const isCompact = windowWidth < 380;
  const centerSize = isCompact ? 58 : 64;
  const barHeight = isCompact ? 62 : 66;
  const bottomPadding = Math.max(bottomInset, 10);
  const topPadding = hasRaisedCenter() ? Math.round(centerSize * 0.34) : 0;

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
