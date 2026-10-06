/**
 * Who draws a zoom tile's corners. Kept apart from `components/media-zoom.tsx`
 * for the reason `lib/media-zoom-video-offer.ts` is: a preview mounted in every
 * feed card reaches one context without the zoom's animation stack.
 *
 * UIKit's zoom (lib/apple-zoom.ts) draws the view registered as its source by
 * itself, above the reel, from early in a close until the reel has shrunk into
 * it, and from the tap until the reel has grown out of it. A Home card crops a
 * tall clip, so the tile is smaller than the reel's picture and sits inside it
 * for that stretch. Media that still rounded its own corners, or drew its
 * accent outline, stood there as a box of its own: a rounded frame with a line
 * round it, and the source's black ground showing square behind its corners.
 * Filmed on the simulator in both schemes, on Back and on a gesture close
 * alike. With the shape on the source alone the tile is a plain rectangle of
 * the picture the reel is showing, and nothing marks where it begins.
 */
import { createContext, useContext } from 'react';

/** True inside a tile whose zoom source rounds and clips it (`MediaZoomSourceView` under UIKit's zoom). */
export const MediaZoomTileShapedContext = createContext(false);

/**
 * Whether the zoom tile a preview is drawn in gives it its shape, so the
 * preview draws a plain rectangle: no corners of its own and no outline.
 * False outside a zoom tile and wherever UIKit's zoom does not run.
 */
export function useMediaZoomTileShaped() {
  return useContext(MediaZoomTileShapedContext);
}
