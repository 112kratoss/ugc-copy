/**
 * The reel's open and close on iOS 18: UIKit's own zoom transition — the one
 * Photos opens a picture with — instead of the layer's flight in
 * `components/media-zoom.tsx`, which stays the way in on Android.
 *
 * Expo Router binds that transition (`UIViewController.Transition.zoom`) to a
 * route. A tapped tile has registered its native view as the zoom's source
 * under an identifier (`AppleZoomSource`); the push carries the identifier in a
 * route param; Expo Router's own enabler, rendered around every screen, reads
 * the param and sets the pushed screen's `preferredTransition`. UIKit then
 * grows the pushed screen out of the tile's live view, crossfading one into
 * the other on the render server with nothing for the JS thread to do per
 * frame, and shrinks it back on Back, on the edge swipe, on a pinch or a drag
 * down — interactively, following the finger. The close lands in whichever
 * view is registered under the identifier when it begins, so the reel points
 * the param at the tile of the post the reader has moved to
 * (`useAppleZoomRetarget`), and marks where its media sits so the zoom aligns
 * with the picture rather than the whole screen (`AppleZoomTarget`).
 *
 * Only some of Expo Router's pieces are public — `Link.AppleZoom` needs a
 * `Link`, and the tiles open imperatively — so `components/apple-zoom.ios.tsx`
 * reaches the native views through `expo-router/build/...`. The param name is
 * pinned by a test against Expo Router's own constant. Whether a device runs
 * the zoom at all is `lib/apple-zoom-available.ts`, kept apart so that the
 * href builders here pull nothing platform-bound into their import graph.
 */

/** Expo Router's route param naming the registered view a pushed screen zooms out of. */
export const APPLE_ZOOM_SOURCE_PARAM = '__internal_expo_router_zoom_transition_source_id';

/** What a tile hands the open it captured: the zoom to carry in the push. */
export interface AppleZoomOpen {
  /** The tile's registered identifier; see `appleZoomSourceId`. */
  sourceId: string;
}

const SOURCE_ID_PREFIX = 'zoom|';

/**
 * The identifier a tile registers its view under: its surface and its post, so
 * the reel can name the tile of any post on the same surface.
 */
export function appleZoomSourceId(surfaceId: string, itemId: string) {
  return `${SOURCE_ID_PREFIX}${surfaceId}|${itemId}`;
}

/** The surface and post behind an identifier, or null for one this app did not make. */
export function parseAppleZoomSourceId(sourceId: string | null | undefined): { surfaceId: string; itemId: string } | null {
  if (!sourceId || !sourceId.startsWith(SOURCE_ID_PREFIX)) return null;
  const body = sourceId.slice(SOURCE_ID_PREFIX.length);
  // Surface ids come from React's `useId` and contain colons; post ids do not
  // contain the separator, so the last one is the split.
  const split = body.lastIndexOf('|');
  if (split <= 0 || split === body.length - 1) return null;
  return { surfaceId: body.slice(0, split), itemId: body.slice(split + 1) };
}

/** The same href, carrying the zoom for the push; unchanged without one. */
export function withAppleZoom<T extends { pathname: string; params?: Record<string, unknown> }>(
  href: T,
  zoom: AppleZoomOpen | null | undefined
): T {
  if (!zoom) return href;
  return { ...href, params: { ...(href.params ?? {}), [APPLE_ZOOM_SOURCE_PARAM]: zoom.sourceId } };
}

/** Whether a route's params carry a zoom, i.e. the screen was pushed out of a tile. */
export function hasAppleZoomParam(params: object | null | undefined): boolean {
  const value = (params as Record<string, unknown> | null | undefined)?.[APPLE_ZOOM_SOURCE_PARAM];
  return typeof value === 'string' && value.length > 0;
}
