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
 * down — interactively, following the finger, as Instagram's post viewer
 * grows and shrinks its page (filmed side by side on the owner's iPhone,
 * 2026-11-08, `archive/ios-ig-transitions-2026-11-08/`).
 *
 * Each tile registers two views. The push carries the first
 * (`appleZoomOpenSourceId`): the reel's whole page drawn at the tile's scale,
 * black, with the tile's picture over the tile, lined up with the whole screen
 * (`appleZoomPageFrame` in lib/media-zoom-transition.ts). Lined up with the
 * picture instead, the zoom's first frame on an iPhone drew the tile's picture
 * lower in its tile by as much as the picture sits below the top of the screen
 * ("the media goes down first"). Once the push has landed, the reel points the
 * param at the tile's own view (`appleZoomSourceId`), which the closes shrink
 * the reel into, in the tile's shape — the tile of whichever post the reader
 * has moved to (`useAppleZoomRetarget`) — and marks where its media sits so
 * the zoom aligns with the picture (`AppleZoomTarget`). That mark is not
 * mounted once Back has taken the reel out of React, so each tile hands over
 * the same rectangle itself (`AppleZoomSource`, `appleZoomAlignmentRect`).
 * UIKit crossfades the shrinking page into whatever the tile's own view draws,
 * so while the reel shows a post's still picture that view holds the picture,
 * and the close carries it home into the tile instead of fading out short of
 * it (lib/apple-zoom-surface.ts).
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

const OPEN_SOURCE_SUFFIX = '#open';

/**
 * The identifier of the view a tile's open grows the reel out of: the reel's
 * whole page at the tile's scale (`appleZoomPageFrame` in
 * lib/media-zoom-transition.ts), registered beside the tile's own view. A push
 * carries this one; once the reel has landed it points the zoom at the tile's
 * own view (`appleZoomSourceId`) for the closes (`useAppleZoomRetarget`), which
 * then shrink the reel into the tile's shape.
 */
export function appleZoomOpenSourceId(sourceId: string) {
  return sourceId.endsWith(OPEN_SOURCE_SUFFIX) ? sourceId : `${sourceId}${OPEN_SOURCE_SUFFIX}`;
}

/** Whether `sourceId` names the view an open grows out of (`appleZoomOpenSourceId`). */
export function isAppleZoomOpenSourceId(sourceId: string | null | undefined): boolean {
  return typeof sourceId === 'string' && sourceId.endsWith(OPEN_SOURCE_SUFFIX);
}

/** The surface and post behind an identifier, or null for one this app did not make. */
export function parseAppleZoomSourceId(sourceId: string | null | undefined): { surfaceId: string; itemId: string } | null {
  if (!sourceId || !sourceId.startsWith(SOURCE_ID_PREFIX)) return null;
  const body = sourceId.slice(SOURCE_ID_PREFIX.length, isAppleZoomOpenSourceId(sourceId) ? -OPEN_SOURCE_SUFFIX.length : undefined);
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
