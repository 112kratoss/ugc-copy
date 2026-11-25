import { checkMediaAvailability, type MediaAvailability } from '@/lib/media-availability/media-availability';
import { buildMediaSource } from '@/lib/media-source';
import { resolveMediaUrlForExpiry } from '@/lib/media-url-expiry';
import { getShowcasePreviewMediaItems } from '@/lib/showcase-media';
import type { ShowcaseFeedItem } from '@/lib/types';
import { signedMediaIdentity } from '@/lib/use-stable-signed-url';

/**
 * Home's answer to a card whose picture would not load: when the post's media
 * is gone for this viewer (archived, made private, hidden or deleted since the
 * page was read, or since the launch whose first page was kept on the device,
 * `persisted-home-feed.ts`), the card leaves the feed quietly, as a feed drops
 * a post that is no longer there; any other failure keeps the card and its
 * Retry (`StableMediaImage`). What counts as gone is the shared rule,
 * `media-availability/media-availability.ts`, which the web's Home asks too.
 *
 * The media found gone is remembered for the rest of the launch, by the file
 * it names rather than by post, so a page read afterwards that still names it
 * keeps the post out, and a post its creator edited with new media comes back
 * with that media.
 */

const goneMediaFiles = new Set<string>();

export function rememberGoneFeedMedia(url: string) {
  goneMediaFiles.add(signedMediaIdentity(url));
}

export function holdsGoneFeedMedia(item: ShowcaseFeedItem): boolean {
  if (!goneMediaFiles.size) return false;
  return getShowcasePreviewMediaItems(item).some((media) => goneMediaFiles.has(signedMediaIdentity(media.url)));
}

export function filterGoneFeedMedia(items: ShowcaseFeedItem[]): ShowcaseFeedItem[] {
  if (!goneMediaFiles.size) return items;
  return items.filter((item) => !holdsGoneFeedMedia(item));
}

export function resetGoneFeedMediaForTests() {
  goneMediaFiles.clear();
}

type FeedMediaRequestContext = {
  apiBaseUrl: string;
  storageBaseUrl: string;
  accessToken?: string | null;
  /** The clock, read here rather than by the screen: React Compiler skips a component that reads it. */
  now?: number;
};

/**
 * The request the card's picture made for `url`, so the question gets the
 * answer the picture got: a signed address near its end goes to the media
 * route, and the media route gets the session (`useMediaSource`).
 */
export function feedMediaAvailabilityRequest(url: string, context: FeedMediaRequestContext) {
  const now = context.now ?? Date.now();
  const effectiveUrl = resolveMediaUrlForExpiry(url, context.storageBaseUrl, context.apiBaseUrl, now);
  return buildMediaSource(effectiveUrl, context.apiBaseUrl, context.accessToken);
}

export function checkFeedMediaAvailability(
  url: string,
  context: FeedMediaRequestContext,
  fetchImpl?: typeof fetch,
): Promise<MediaAvailability> {
  const { uri, headers } = feedMediaAvailabilityRequest(url, context);
  return checkMediaAvailability(uri, { headers, ...(fetchImpl ? { fetchImpl } : {}) });
}
