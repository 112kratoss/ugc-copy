import type { ShowcaseFeedItem, ShowcaseMediaItem } from './types';

export function getShowcasePreviewMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
  if (item.mediaItems?.length) return item.mediaItems;
  if (!item.mediaUrl) return [];

  const mediaKind = item.mediaKind ?? (item.category === 'video' ? 'video' : 'image');

  return [{
    id: `${item.id}:primary`,
    url: item.mediaUrl,
    // A post-level media URL is the source of record, not proof that a small
    // derivative exists. Keep legacy records on the same placeholder path so
    // normal feed tiles never disguise the original as a preview download.
    previewUrl: null,
    previewThumbhash: null,
    previewCacheKey: item.id,
    gridReady: mediaKind === 'image',
    mediaKind,
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

export function hasShowcasePreviewMedia(item: ShowcaseFeedItem) {
  return getShowcasePreviewMediaItems(item).length > 0;
}

export function getShowcaseMediaPreviewUrl(item: ShowcaseMediaItem) {
  return item.preview?.previewUrl ?? item.previewUrl ?? null;
}

export type ShowcaseImageTileSource = 'preview' | 'source-fallback' | 'pending';

/**
 * Choose what a small image tile may fetch without turning a missing derivative
 * into a full-resolution source download. The source is only a recovery path
 * after a real preview URL failed; a preview that does not exist yet stays a
 * lightweight placeholder.
 */
export function resolveShowcaseImageTileSource(
  item: ShowcaseMediaItem,
  failedPreviewUrl: string | null,
): ShowcaseImageTileSource {
  const previewUrl = getShowcaseMediaPreviewUrl(item);
  if (!previewUrl) return 'pending';
  if (previewUrl === failedPreviewUrl) return 'source-fallback';
  return 'preview';
}

/**
 * The small feed copy, or null when the backend has not produced one. Callers
 * that need a guaranteed URL should use getShowcasePlaybackUrl.
 */
export function getShowcaseMediaRenditionUrl(item: ShowcaseMediaItem): string | null {
  return item.preview?.renditionUrl ?? item.renditionUrl ?? null;
}

/**
 * What the immersive viewer streams for a deliberate watch. Prefers the small
 * rendition and falls back to the source, so posts published before the
 * rendition pipeline — and ones that legitimately skipped it — still play.
 *
 * The viewer deliberately insisted on `url` for full quality until the 2026-08
 * scaling audit measured the cost: sources run ~23 Mbps against a 720p/1.4 Mbps
 * rendition, and the watch surfaces are 80-90% of all storage egress. On Indian
 * mobile networks the source was also simply worse to watch. `url` stays the
 * source of record for downloads and remixes, where quality is the point.
 */
export function getShowcasePlaybackUrl(item: ShowcaseMediaItem): string {
  return getShowcaseMediaRenditionUrl(item) ?? item.url;
}

/**
 * What an autoplaying FEED card may stream — deliberately not
 * getShowcasePlaybackUrl. A feed glance must never pull the raw source: that
 * `renditionUrl ?? url` fallback is exactly how a long video whose transcode
 * failed used to stream tens of MB per scroll.
 *
 * The server's `feedStreamUrl` decision is authoritative when the field is
 * PRESENT — including an explicit null, which means poster-only (`??` would
 * wrongly skip past that verdict into the fallbacks). Only when the field is
 * absent entirely (older server) does the client fall back to teaser, then
 * rendition — and never to `url`.
 */
export function getShowcaseFeedStreamUrl(item: ShowcaseMediaItem): string | null {
  const descriptorDecision = item.preview ? item.preview.feedStreamUrl : undefined;
  if (descriptorDecision !== undefined) return descriptorDecision;
  if (item.feedStreamUrl !== undefined) return item.feedStreamUrl;
  return item.preview?.teaserUrl ?? item.teaserUrl ?? getShowcaseMediaRenditionUrl(item);
}

export function hasShowcaseVideoWithoutPreview(item: ShowcaseFeedItem) {
  return getShowcasePreviewMediaItems(item).some((mediaItem) =>
    mediaItem.mediaKind === 'video' && !getShowcaseMediaPreviewUrl(mediaItem)
  );
}
