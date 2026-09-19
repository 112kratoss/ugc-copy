/**
 * How a zoom tile's video layer offers its playing player to the zoom out of
 * the tile. Kept apart from `components/media-zoom.tsx` so that a feed tile's
 * player — mounted in every video card — does not pull the zoom's animation
 * stack into its own import graph just to reach one context.
 *
 * The loan itself, once a tap takes the offer up, is `lib/video-player-loans.ts`.
 */
import { createContext, useContext } from 'react';
import type { VideoPlayer } from 'expo-video';

/** A tile's playing video, offered to the flight out of the tile. */
export interface MediaZoomVideoOffer {
  player: VideoPlayer;
  /** The stream it plays. Offered only when the reel would play this same file. */
  url: string;
  /** Whether it has drawn a frame into the tile — a player with nothing drawn has nothing to fly. */
  hasFrame: () => boolean;
  /** Attaches the player to the tile's own view again, for a loan that ends unadopted. */
  reattach: () => void;
}

/** Offers a player; the returned function withdraws that same offer. */
export type OfferMediaZoomVideo = (offer: MediaZoomVideoOffer) => () => void;

export const MediaZoomVideoOfferContext = createContext<OfferMediaZoomVideo | null>(null);

/**
 * For a tile's video layer: offers its player to the zoom out of the tile, so
 * the flight and the reel carry the video the reader is watching. Null outside
 * a zoom tile, where there is nothing to offer it to.
 */
export function useMediaZoomVideoOffer() {
  return useContext(MediaZoomVideoOfferContext);
}

/** The zoom tile a video is drawn in (`zoomTileKey`), for a reel handing its player back. */
export const MediaZoomTileKeyContext = createContext<string | null>(null);

/**
 * The tile a video layer belongs to, so it can take back the player a reel
 * closing into it returns (`handBackVideoPlayer`). Null outside a zoom tile.
 */
export function useMediaZoomTileKey() {
  return useContext(MediaZoomTileKeyContext);
}
