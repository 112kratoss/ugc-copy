/**
 * The pictures the grid's tiles are drawing, by media item: the reel opened from a tile draws the
 * same picture in its first frame, while its own larger copy (the 1440px display copy, which the
 * grid never loads) is on its way.
 *
 * Owner's recording, 2026-11-16: a press on a tile opened the reel on a black picture, the reel's
 * loading cover over its display copy, for about a third of a second before the picture showed.
 *
 * The element itself, not its address: the picture is copied from the decoded element, which needs
 * no request at all (`TilePictureStandIn` in ShowcaseMediaCarousel.tsx), where a new <img> for the
 * same address is drawn only once the browser has answered it, a frame or more later. A tile holds
 * its entry while its picture is mounted, so nothing outlives the grid.
 */
const tilePictures = new Map<string, HTMLImageElement>();

/** A tile draws `image` for the media item `mediaItemId`. */
export function holdTilePicture(mediaItemId: string, image: HTMLImageElement): void {
  tilePictures.set(mediaItemId, image);
}

/** The tile no longer draws `image` (it unmounted, or now draws another). */
export function releaseTilePicture(mediaItemId: string, image: HTMLImageElement): void {
  if (tilePictures.get(mediaItemId) === image) {
    tilePictures.delete(mediaItemId);
  }
}

/** The picture a tile has drawn for the media item, once it has loaded; null when no tile has one. */
export function loadedTilePicture(mediaItemId: string | null | undefined): HTMLImageElement | null {
  const image = mediaItemId ? tilePictures.get(mediaItemId) : undefined;
  return image && image.complete && image.naturalWidth > 0 ? image : null;
}

/** A tile's picture standing in for a media item of the reel. */
export interface TilePictureStandIn {
  mediaItemId: string;
  image: HTMLImageElement;
}

/**
 * Whether the reel draws a tile's picture in place of its media item, the one place that decides
 * it: the reel's own copy neither loaded nor failed yet, a picture (a clip has its poster), its
 * source still there, and a tile holding that picture loaded. The reel leaves its black loading
 * cover off exactly when this answers one, and the carousel draws what it answers.
 */
export function tilePictureStandIn(
  mediaItem: { id: string; mediaKind: string; sourceUnavailableAt?: string | null } | null | undefined,
  reelCopyLoading: boolean,
): TilePictureStandIn | null {
  if (!reelCopyLoading || !mediaItem || mediaItem.mediaKind !== 'image' || mediaItem.sourceUnavailableAt) {
    return null;
  }
  const image = loadedTilePicture(mediaItem.id);
  return image ? { mediaItemId: mediaItem.id, image } : null;
}
