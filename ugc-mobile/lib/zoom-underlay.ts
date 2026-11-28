import { Platform } from 'react-native';
import { makeMutable } from 'react-native-reanimated';

/**
 * Whether the tab screen under an open reel is hidden: 1 from the moment the
 * reel has been uncovered and settled until a close begins.
 *
 * On Android the viewer is a transparent modal, so the screen it opened from
 * stays attached beneath it, and the renderer draws every view of that screen
 * — the Explore grid's pictures, icons and text — under every frame of the
 * reel's video. Traced on the S24 (2026-09-19): about 22 of the reel's 42
 * texture draws per frame were the covered grid. At opacity 0 the whole
 * subtree is skipped for drawing, with no relayout when it comes back for the
 * close.
 *
 * Hidden by opacity alone: the screen never leaves layout. From 2026-09-19 to
 * 2026-11-28 it was also made `display: 'none'` a moment after hiding, to end
 * the renderer's walk of a subtree it does not draw (`prepareTree`, about
 * 2.2 ms of a 9 ms frame on the S24 that night), and put back as a close
 * began. That moved the list beneath, so Back from a reel landed on other
 * posts (the owner's S24, 2026-11-28):
 *
 * - React Native lays nothing out under a `display: 'none'` view, and from the
 *   second time a subtree is hidden its native views stand at the frames of an
 *   earlier hide. Explore's content stood 4218 px tall natively, the height it
 *   had when the first post was opened, while it was really 8012.
 * - The store build's scroll view (0.1.9, `patches/react-native`) brings its
 *   offset back within its content the moment it is visible again
 *   (`onVisibilityAggregated`), which is before that commit's frames reach its
 *   content. So it clamped to the old height: a post opened two screens
 *   further down than an earlier one closed onto the grid of the earlier one
 *   (offset 5200 to 3294 on the Pixel 9a emulator), whatever was done in the
 *   reel.
 *
 * `__tests__/zoom-underlay.test.ts` keeps `display` out of the tabs' style. The
 * walk can be ended again only once that native clamp waits for the commit's
 * frames, which takes a store build; a list under any other view that toggles
 * `display` has the same fault.
 *
 * iOS pushes the reel as a card: nothing is drawn beneath a pushed screen, and
 * UIKit's own zoom transition (lib/apple-zoom.ts) brings the feed back for the
 * close itself, so there is nothing to hide there.
 */
export const zoomUnderlayHidden = makeMutable(0);

export const ZOOM_UNDERLAY_HIDES = Platform.OS === 'android';

export function setZoomUnderlayHidden(hidden: boolean) {
  if (!ZOOM_UNDERLAY_HIDES) return;
  zoomUnderlayHidden.set(hidden ? 1 : 0);
}
