import { makeMutable, withDelay, withTiming } from 'react-native-reanimated';

import { isAppleZoomAvailable } from './apple-zoom-available';
import type { ZoomRect } from './media-zoom-transition';
import { activateNativeZoomVeil, prepareNativeZoomVeil, resetNativeZoomVeil } from './native-zoom-veil';

/**
 * How much of the screen a reel grew out of is covered in black while UIKit's
 * zoom runs (lib/apple-zoom.ts): 1 from the tap until the reel has landed, and
 * again until a close has shrunk it most of the way back; 0 otherwise.
 *
 * UIKit crossfades the tile into the reel as the window grows, and the reel
 * back into the tile as it shrinks. A crossfade is two pictures at part
 * opacity, and between them whatever lies beneath shows through: for a quarter
 * of a second the growing picture was washed with the light feed behind it,
 * measured on the simulator as the picture's darkest pixels lifting from 22 to
 * 67 of 255. UIKit's own dimming of that feed is slight while the crossfade
 * runs (even told to dim to black it takes 250 ms to get there, the crossfade
 * is over by then, and the close bled the same way) and offers no control over
 * the crossfade itself, so the app covers the feed in black under the
 * transition, the way Photos darkens its grid, and the pictures cross over
 * black instead. The veil lifts as a close begins — after the crossfade, over
 * the rest of the shrink — so the feed comes back behind the shrinking
 * picture. Interactive closes follow react-native-screens' native transition
 * progress instead of the elapsed-time fade, so holding or reversing a gesture
 * does not let the background finish independently of the zoom.
 *
 * The tile itself stays clear of the veil until the transition begins
 * (`zoomVeilHole`): UIKit takes the tile's picture into its own view only as
 * the push starts, some frames after the tap, and a veil over the tile too
 * blacked the whole screen out for that stretch before the picture appeared.
 *
 * Every screen a reel can grow out of draws it above everything else on that
 * screen (`components/zoom-veil.tsx`), and only the one directly beneath the
 * reel is ever seen. Android and iOS before 18 open the reel another way and
 * never veil.
 */
export const zoomVeil = makeMutable(0);
/** The tapped tile's rectangle on screen, left clear until the transition begins; null for none. */
export const zoomVeilHole = makeMutable<(ZoomRect & { radius?: number }) | null>(null);

/**
 * After the crossfade at the start of a close, before the feed comes back:
 * measured on the simulator, the reel and the tile cross over 130–170 ms into
 * a close, which the veil has to outlast.
 */
export const ZOOM_VEIL_LIFT_DELAY_MS = 150;
/** Over which the feed comes back: the rest of the visible shrink, which lands at about 300 ms. */
export const ZOOM_VEIL_LIFT_MS = 200;
/** A veil no reel claims — the push never came — lifts by itself after this. */
export const ZOOM_VEIL_DEADLINE_MS = 4000;

let deadline: ReturnType<typeof setTimeout> | null = null;
let claimed = false;
let closing: 'timed' | 'interactive' | null = null;

function clearDeadline() {
  if (!deadline) return;
  clearTimeout(deadline);
  deadline = null;
}

/**
 * The tap that opens a reel: the feed goes black around the tapped tile, under
 * the transition that follows. `hole` is the tile's rectangle on screen.
 */
export function dropZoomVeil(hole: (ZoomRect & { radius?: number }) | null) {
  if (!isAppleZoomAvailable()) return;
  claimed = false;
  closing = null;
  prepareNativeZoomVeil();
  zoomVeilHole.set(hole);
  zoomVeil.set(1);
  clearDeadline();
  deadline = setTimeout(() => {
    deadline = null;
    if (!claimed) clearZoomVeil();
  }, ZOOM_VEIL_DEADLINE_MS);
}

/** The reel that was pushed is up: the veil is its to lift. */
export function claimZoomVeil() {
  claimed = true;
  clearDeadline();
}

/** The push has begun: UIKit is drawing the tile's picture above the veil now, so the veil covers the tile too. */
export function closeZoomVeilHole() {
  zoomVeilHole.set(null);
}

/** A close has begun: the feed comes back behind the shrinking reel. */
export function liftZoomVeil(interactive = false) {
  if (!isAppleZoomAvailable()) return;
  clearDeadline();
  zoomVeilHole.set(null);
  // A gesture can be held or reversed indefinitely. Follow UIKit instead of
  // completing a timer while the reader's finger is still on the screen.
  if (interactive && activateNativeZoomVeil()) {
    closing = 'interactive';
    zoomVeil.set(1);
    return;
  }
  if (closing === 'interactive') return;
  closing = 'timed';
  resetNativeZoomVeil();
  zoomVeil.set(withDelay(ZOOM_VEIL_LIFT_DELAY_MS, withTiming(0, { duration: ZOOM_VEIL_LIFT_MS })));
  deadline = setTimeout(clearZoomVeil, ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS);
}

/** A close let go of before it committed: the reel is back, and so is the veil. */
export function holdZoomVeil() {
  if (!isAppleZoomAvailable()) return;
  clearDeadline();
  closing = null;
  resetNativeZoomVeil();
  zoomVeilHole.set(null);
  zoomVeil.set(1);
}

/** The reel has gone, however it went: nothing is left to veil. */
export function clearZoomVeil() {
  resetNativeZoomVeil();
  closing = null;
  claimed = false;
  clearDeadline();
  zoomVeilHole.set(null);
  zoomVeil.set(0);
}

/** Back unmounts React before UIKit's snapshot finishes shrinking. */
export function releaseZoomVeil() {
  if (closing === 'timed') return;
  clearZoomVeil();
}

/** Test support. */
export function resetZoomVeil() {
  clearZoomVeil();
}
