import { Image, type ImageLoadOptions } from 'expo-image';
import { Platform } from 'react-native';

import { env } from './env';
import { buildMediaSource } from './media-source';
import { resolveMediaUrlForExpiry } from './media-url-expiry';

/** A picture as a tile asks expo-image for it: its link, and the key it is cached under. */
export type WarmImage = { url: string; cacheKey: string };

/** The size, in pixels, the tiles that will draw the pictures draw them at. */
export type WarmTile = { width: number; height: number };

/**
 * The source `useMediaSource` builds for a link, outside a render: a signed
 * Storage link about to expire goes through the media proxy, and only that proxy
 * is sent the session (`buildMediaSource` decides). `__tests__/media-image-warmup.test.tsx`
 * holds the two to one answer, since a warm-up under any other source fills a
 * cache entry no tile reads.
 */
export function mediaSourceFor(url: string, accessToken: string | null | undefined, now: number) {
  return buildMediaSource(resolveMediaUrlForExpiry(url, env.supabaseUrl, env.apiBaseUrl, now), env.apiBaseUrl, accessToken);
}

/** Each picture asked for this launch, by the key it is cached under, whether or not it loaded. */
const warmed = new Set<string>();
/** Every warm-up's loads, one after another across all of them. */
let queue: Promise<void> = Promise.resolve();

/**
 * Loads pictures into expo-image's disk cache under the keys the tiles that will
 * draw them use, so a list drawn later reads them from the disk rather than the
 * network. `Image.prefetch` cannot: it caches under the link, and the tiles ask
 * under their own `cacheKey`. `Image.loadAsync` takes the tile's whole source
 * (both platforms then store the file under that key) and returns the decoded
 * picture, let go at once.
 *
 * One load at a time, across every warm-up: on iOS `loadAsync` runs through a
 * process-wide manager that is built lazily, and calls that overlapped before it
 * existed crashed the app (fd29cc597, 2026-08-23). Each picture is asked for once
 * a launch, by its key: a library read again signs its files anew, and under a
 * key already on the disk a new link is read from the disk, so asking again
 * would only decode it again. Returns a stop, which takes effect before the next
 * picture.
 *
 * On Android a picture loaded here is decoded at its full size unless given one
 * (`ImageLoadTask` asks Glide for `SIZE_ORIGINAL`), only to be let go: there it
 * is decoded at no more than `tile`. The disk keeps the file as it was
 * downloaded, whatever size it is decoded at. iOS keeps its full-size decode:
 * there a size changes the key SDWebImage files the decoded picture under
 * (`imageThumbnailPixelSize`), and whether the downloaded file still lands
 * under the tile's key has not been looked at.
 */
export function warmImages(
  images: readonly WarmImage[],
  accessToken: string | null | undefined,
  tile?: WarmTile,
): () => void {
  let stopped = false;
  const options: ImageLoadOptions | undefined = Platform.OS === 'android' && tile
    ? { maxWidth: Math.ceil(tile.width), maxHeight: Math.ceil(tile.height) }
    : undefined;
  for (const image of images) {
    queue = queue.then(async () => {
      if (stopped || warmed.has(image.cacheKey)) return;
      warmed.add(image.cacheKey);
      try {
        const loaded = await Image.loadAsync(
          { ...mediaSourceFor(image.url, accessToken, Date.now()), cacheKey: image.cacheKey },
          options,
        );
        loaded.release();
      } catch {
        // Only a head start: the tile loads the picture itself when it is drawn.
      }
    });
  }
  return () => {
    stopped = true;
  };
}
