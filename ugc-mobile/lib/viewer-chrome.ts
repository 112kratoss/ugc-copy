/**
 * The immersive viewer draws its top controls from two different components —
 * the reel screen owns Back, the mute toggle and the refresh spinner, while
 * each slide owns its own media counter — so the two cannot see each other's
 * frames. Before this module they collided: the counter sat at a hard-coded
 * `top: 68` (no safe area at all) and the refresh spinner at `topInset + 24`,
 * which overlap on every device whose top inset is more than 34pt.
 *
 * Every offset in the viewer's top strip is derived here instead, from the
 * resolved safe-area inset, so HIG *Layout*'s "make sure essential content
 * fits within the safe area" holds and `hig-full-screen.test.ts` can prove the
 * two rows do not overlap without rendering anything.
 */

/** Gap between the safe-area inset and the first row of controls. */
export const VIEWER_TOP_CONTROL_OFFSET = 10;
/** Back and mute are 48pt targets — the app's touch floor (`lib/hit-target`). */
export const VIEWER_TOP_CONTROL_SIZE = 48;
/** Breathing room between the control row and the badge row beneath it. */
export const VIEWER_TOP_ROW_GAP = 8;

/** Top edge of the control row: Back on the leading side, mute on the trailing. */
export function viewerTopControlTop(topInset: number) {
  return topInset + VIEWER_TOP_CONTROL_OFFSET;
}

/** Top edge of the badge row: the media counter, and the reel's refresh spinner. */
export function viewerTopBadgeTop(topInset: number) {
  return viewerTopControlTop(topInset) + VIEWER_TOP_CONTROL_SIZE + VIEWER_TOP_ROW_GAP;
}
