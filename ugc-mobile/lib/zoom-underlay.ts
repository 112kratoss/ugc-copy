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
 * subtree is skipped, with no relayout when it comes back for the close.
 *
 * iOS pushes the viewer as a card and keeps its own pop gesture, which would
 * uncover a hidden screen mid-swipe, so it is left alone there.
 */
export const zoomUnderlayHidden = makeMutable(0);

export const ZOOM_UNDERLAY_HIDES = Platform.OS === 'android';

export function setZoomUnderlayHidden(hidden: boolean) {
  if (!ZOOM_UNDERLAY_HIDES) return;
  zoomUnderlayHidden.set(hidden ? 1 : 0);
}
