import { easedFade } from './eased-fade';

/**
 * How far below the status bar the tab roots' shade runs out, in points. It
 * stays inside the gap every tab root leaves above its first row at rest
 * (Home's top bar 10pt under the inset, Explore's and Profile's titles 12,
 * Alerts' 18), so the shade covers nothing until the list scrolls.
 */
export const TAB_ROOT_TOP_SCRIM_TAIL = 10;

export interface TopScrimStop {
  /** Distance from the top of the shade, in points. */
  offset: number;
  alpha: number;
}

/**
 * The shade over the status bar on the tab roots (Home, Explore, Alerts,
 * Profile), whose lists scroll underneath it: the screen's own ground, solid
 * over the whole inset, then the shared eased fade over the tail below it.
 *
 * It used to fade in a straight line from the top of the inset to its foot,
 * so the clock and icons, which sit in the middle of the inset on both
 * platforms (27–40pt of a 72pt inset on an iPhone 17 Pro, centred in Android's
 * bar), stood over content still drawn at 40 to 60 per cent: the profile's
 * @handle on the S24 and its credits card on the iPhone (feel audit
 * 2026-11-27). Over the app's own ground, unlike the reel's photos, nothing is
 * lost by holding it solid: where no content has scrolled up, solid ground over
 * ground looks like nothing at all.
 */
export function tabRootTopScrim(topInset: number): { height: number; stops: TopScrimStop[] } {
  const height = topInset + TAB_ROOT_TOP_SCRIM_TAIL;
  return {
    height,
    stops: [
      { offset: 0, alpha: 1 },
      ...easedFade(1).map(({ at, alpha }) => ({ offset: topInset + at * TAB_ROOT_TOP_SCRIM_TAIL, alpha })),
    ],
  };
}
