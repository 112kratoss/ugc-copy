import type { Sharp } from 'sharp';

import { getMediaContentHash } from '@/lib/media-preview-metadata';

/**
 * The second image size: big enough to fill a phone screen, small enough that
 * opening one is not a megabyte.
 *
 * The 720px preview exists for grids, where it is the right size and 25 KB is
 * the right cost. A full-screen viewer needs more than that, so it used to
 * reach past the preview and load the source — 1.2 MB on average for a stored
 * generation, 2.2 MB for a published showcase copy, and up to 7.9 MB. Images
 * were 48% of a day's Storage bytes that way, more than every video kind
 * together.
 *
 * 1440px on the long edge covers a 3x phone (a 393pt-wide screen renders
 * ~1179px) with room for a pinch before the original is worth fetching, and
 * lands at 150–300 KB as WebP. The original stays the download and the
 * zoom target; nothing here replaces it.
 */
export const DISPLAY_MAX_SIZE = 1440;

/**
 * A display rendition has to beat the source by enough to be worth storing and
 * cache-warming. Under this margin the source is already display-sized (or is
 * a small PNG that WebP cannot improve on), and a second object would cost
 * storage and a second round trip to save nothing.
 */
const MIN_DISPLAY_SAVING = 0.25;

export function buildDisplayRenditionPath(storagePath: string, contentHash: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.display.${contentHash}.webp`;
}

/**
 * Encodes the display rendition, or returns null when one is not worth having.
 *
 * Null is a normal answer, not a failure: the caller records no path and every
 * reader falls back to the source exactly as it did before this existed. Only
 * a real saving earns an object.
 */
export async function encodeDisplayRendition({
  image,
  sourceBytes,
  width,
  height,
}: {
  image: Sharp;
  sourceBytes: number;
  width: number | null | undefined;
  height: number | null | undefined;
}): Promise<{ body: Buffer; storagePathHash: string; width: number; height: number } | null> {
  // An image that is already preview-sized is served by the preview; a second
  // copy of it would be the same picture twice.
  const longestEdge = Math.max(width ?? 0, height ?? 0);
  if (longestEdge > 0 && longestEdge <= DISPLAY_MAX_SIZE && sourceBytes > 0) {
    // Still worth re-encoding a large-but-small-dimensioned source (a 4 MB PNG
    // at 1200px), so only skip when the source is both small and modest.
    if (sourceBytes <= 400_000) return null;
  }

  const resized = image
    .clone()
    .resize({
      width: DISPLAY_MAX_SIZE,
      height: DISPLAY_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 });
  const { data, info } = await resized.toBuffer({ resolveWithObject: true });

  if (sourceBytes > 0 && data.byteLength > sourceBytes * (1 - MIN_DISPLAY_SAVING)) {
    return null;
  }

  return {
    body: data,
    storagePathHash: getMediaContentHash(data),
    width: info.width,
    height: info.height,
  };
}
