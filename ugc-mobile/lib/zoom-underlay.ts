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
 * close — but the renderer still walks it every frame (`prepareTree`, about
 * 2.2 ms of a 9 ms frame, measured the same night). So a moment after hiding,
 * once the reel is at rest, the screen is also taken out of layout
 * (`zoomUnderlayDetached`, `display: 'none'`), which ends the walk; it is put
 * back the instant a close begins, in the same call that shows it again.
 *
 * iOS pushes the viewer as a card and keeps its own pop gesture, which would
 * uncover a hidden screen mid-swipe, so it is left alone there.
 */
export const zoomUnderlayHidden = makeMutable(0);
/** 1 once the hidden screen is also out of layout; always 0 while it is shown. */
export const zoomUnderlayDetached = makeMutable(0);

export const ZOOM_UNDERLAY_HIDES = Platform.OS === 'android';
/** After hiding: past the hand-off fade and the neighbour mounts, so the relayout lands in a resting reel. */
export const ZOOM_UNDERLAY_DETACH_DELAY_MS = 450;

let detachTimer: ReturnType<typeof setTimeout> | null = null;

export function setZoomUnderlayHidden(hidden: boolean) {
  if (!ZOOM_UNDERLAY_HIDES) return;
  zoomUnderlayHidden.set(hidden ? 1 : 0);
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
  if (hidden) {
    detachTimer = setTimeout(() => {
      detachTimer = null;
      zoomUnderlayDetached.set(1);
    }, ZOOM_UNDERLAY_DETACH_DELAY_MS);
  } else {
    zoomUnderlayDetached.set(0);
  }
}
