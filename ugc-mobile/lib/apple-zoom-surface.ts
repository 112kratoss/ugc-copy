/** A covered list prepares the current post's tile before UIKit asks for it. */
const surfaces = new Map<string, (itemId: string) => void>();
const requested = new Map<string, string>();

export function registerAppleZoomSurface(surfaceId: string, reveal: (itemId: string) => void) {
  surfaces.set(surfaceId, reveal);
  const itemId = requested.get(surfaceId);
  if (itemId) reveal(itemId);
  return () => {
    if (surfaces.get(surfaceId) === reveal) surfaces.delete(surfaceId);
  };
}

export function prepareAppleZoomReturn(surfaceId: string, itemId: string) {
  requested.set(surfaceId, itemId);
  surfaces.get(surfaceId)?.(itemId);
}

export function clearAppleZoomReturn(surfaceId: string, itemId: string) {
  if (requested.get(surfaceId) === itemId) requested.delete(surfaceId);
}

export function forgetAppleZoomSurface(surfaceId: string) {
  surfaces.delete(surfaceId);
  requested.delete(surfaceId);
  const prefix = `${surfaceId} `;
  let changed = false;
  for (const key of [...returnPictures.keys()]) {
    if (!key.startsWith(prefix)) continue;
    dropReturnPicture(key);
    changed = true;
  }
  if (changed) emitReturnPictures();
}

// ---------------------------------------------------------------------------
// The picture a close lands on
// ---------------------------------------------------------------------------

/**
 * UIKit's zoom shrinks a closing reel into a view beside the tile of the post
 * the reader is on, crossfading the reel's page into whatever that view draws
 * (lib/apple-zoom.ts). Empty, as the view is while nothing is closing into it,
 * the page faded to nothing well before it reached the tile, at about
 * two-thirds of its size: a picture's close read as a fade, with the tile's
 * own copy of the picture showing through the fading page as a second, smaller
 * one (owner, 2026-11-10: "when the image is closing we dont have any
 * animation its just fades"). Photos gives the same zoom its thumbnail, so the
 * picture is on screen all the way down into its cell.
 *
 * So the reel asks the tile it would close into to hold its picture in that
 * view (`holdAppleZoomReturnPicture`) for as long as it shows that picture,
 * and the tile hides what it draws itself under it: UIKit takes the view out
 * of the page while it flies, and the tile's own picture would show in its
 * place beside the one coming home. The picture is let go once the close has
 * put it in the tile (`releaseAppleZoomReturnPicture`), and the tile draws
 * itself again in its place, badges and all.
 *
 * When that is depends on who closed the reel. UIKit keeps the picture it flew
 * over the tile until its transition ends, which it reports 0.5 to 1.1 s after
 * the picture has stopped: left to that, a tile's badge came back a second
 * after its picture. A pop UIKit begins (the bar's Back, a drag, the edge
 * swipe) leaves the reel in React until it has ended, and the reel says when
 * its picture has landed (`AppleZoomReturnLandingCue`). A pop the app asks for
 * takes the reel out of React before UIKit has asked what to shrink it into,
 * so the reel lets go with `afterPop` and the picture waits here: for the pop
 * to begin (`noteAppleZoomPopBegan`) and then for as long as that pop takes to
 * land it.
 *
 * This register is the part with no React in it. A tile reads whether it is
 * held with `isAppleZoomReturnPictureHeld` and hears changes through
 * `subscribeToAppleZoomReturnPictures`.
 */
interface HeldReturnPicture {
  /** Set while the picture waits out the pop that lands it before it is let go. */
  landing: ReturnType<typeof setTimeout> | null;
}

/**
 * How long a close that nothing holds takes to put its picture in the tile and
 * be done with the reel's page: counted from when the close is heard of, or
 * from the lift of the finger that dragged it.
 *
 * The picture is flown over the page, and the tile is under it. On the iPhone
 * 16e the page stays whole until the picture is nearly home, about 150 ms in,
 * and has faded by 250 ms; a tile shown before that stood dimmed under what
 * was left of the page for three frames (filmed 2026-11-10, light scheme,
 * where the page's black shows most). After a drag the page takes about as
 * long from the lift. The simulator fades the page from the start instead, so
 * this is the phone's figure, with a few frames to spare.
 */
export const APPLE_ZOOM_RETURN_LANDS_AFTER_MS = 300;

/**
 * A pop that is never heard to begin or end lets the picture go after this.
 * Past the end of any pop: UIKit reports a zoom's end up to a second after it
 * has visibly landed (lib/use-screen-leaving.ts).
 */
export const APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS = 1500;

const returnPictures = new Map<string, HeldReturnPicture>();
const returnPictureListeners = new Set<() => void>();

function returnPictureKey(surfaceId: string, itemId: string) {
  return `${surfaceId} ${itemId}`;
}

function emitReturnPictures() {
  returnPictureListeners.forEach((listener) => listener());
}

function dropReturnPicture(key: string) {
  const held = returnPictures.get(key);
  if (!held) return false;
  if (held.landing) clearTimeout(held.landing);
  returnPictures.delete(key);
  return true;
}

/** The reel shows this post's picture: its tile holds the picture for the close. */
export function holdAppleZoomReturnPicture(surfaceId: string, itemId: string) {
  const key = returnPictureKey(surfaceId, itemId);
  const held = returnPictures.get(key);
  if (held) {
    // Held again while a pop was still landing it: it stays, and no longer lands.
    if (held.landing) clearTimeout(held.landing);
    held.landing = null;
    return;
  }
  returnPictures.set(key, { landing: null });
  emitReturnPictures();
}

/**
 * The reel lets the tile's picture go: at once when it has moved to another
 * post, its close has landed or its pop is over, or (`afterPop`) once the pop
 * that is about to carry the reel into the tile has landed it there. A reel
 * the app pops is out of React before UIKit asks for the view to shrink it
 * into, and the picture has to be there for that pop.
 */
export function releaseAppleZoomReturnPicture(surfaceId: string, itemId: string, afterPop: boolean) {
  const key = returnPictureKey(surfaceId, itemId);
  const held = returnPictures.get(key);
  if (!held) return;
  if (!afterPop) {
    dropReturnPicture(key);
    emitReturnPictures();
    return;
  }
  if (held.landing) return;
  held.landing = landReturnPictureAfter(key, APPLE_ZOOM_RETURN_LANDING_DEADLINE_MS);
}

function landReturnPictureAfter(key: string, ms: number) {
  return setTimeout(() => {
    if (dropReturnPicture(key)) emitReturnPictures();
  }, ms);
}

/**
 * For the root navigator: a screen of it has begun to come back into view, as
 * the one a reel closes into does when the reel's pop begins. Every picture
 * that was waiting on a pop the app asked for is let go once that pop has had
 * the time to land it (`APPLE_ZOOM_RETURN_LANDS_AFTER_MS`). No finger holds
 * such a pop.
 */
export function noteAppleZoomPopBegan() {
  for (const [key, held] of returnPictures) {
    if (!held.landing) continue;
    clearTimeout(held.landing);
    held.landing = landReturnPictureAfter(key, APPLE_ZOOM_RETURN_LANDS_AFTER_MS);
  }
}

/**
 * For the root navigator: a screen of it has finished coming back into view,
 * as the one a reel closed into does when the reel's pop ends. Every picture
 * still waiting on a pop is let go.
 */
export function noteAppleZoomPopEnded() {
  let changed = false;
  for (const [key, held] of [...returnPictures]) {
    if (!held.landing) continue;
    dropReturnPicture(key);
    changed = true;
  }
  if (changed) emitReturnPictures();
}

/** Whether a reel is holding this tile's picture for its close. */
export function isAppleZoomReturnPictureHeld(surfaceId: string | null | undefined, itemId: string | null | undefined) {
  if (!surfaceId || !itemId) return false;
  return returnPictures.has(returnPictureKey(surfaceId, itemId));
}

export function subscribeToAppleZoomReturnPictures(listener: () => void) {
  returnPictureListeners.add(listener);
  return () => {
    returnPictureListeners.delete(listener);
  };
}

/** Test seam: this module's state is deliberately global, so tests reset it. */
export function resetAppleZoomReturnPictures() {
  for (const key of [...returnPictures.keys()]) dropReturnPicture(key);
  returnPictureListeners.clear();
}
