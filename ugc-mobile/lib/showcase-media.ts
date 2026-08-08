import type { ShowcaseFeedItem, ShowcaseMediaItem } from './types';

export function getShowcasePreviewMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
  if (item.mediaItems?.length) return item.mediaItems;
  if (!item.mediaUrl) return [];

  const mediaKind = item.mediaKind ?? (item.category === 'video' ? 'video' : 'image');

  return [{
    id: `${item.id}:primary`,
    url: item.mediaUrl,
    previewUrl: mediaKind === 'image' ? item.mediaUrl : null,
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

/**
 * The small feed copy, or null when the backend has not produced one. Callers
 * that need a guaranteed URL should use getShowcasePlaybackUrl.
 */
export function getShowcaseMediaRenditionUrl(item: ShowcaseMediaItem): string | null {
  return item.preview?.renditionUrl ?? item.renditionUrl ?? null;
}

/**
 * What any surface that plays a clip should stream — the scrolling feed row and
 * the immersive viewer alike. Prefers the small rendition and falls back to the
 * source, so posts published before the rendition pipeline — and ones that
 * legitimately skipped it — still play.
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

export function hasShowcaseVideoWithoutPreview(item: ShowcaseFeedItem) {
  return getShowcasePreviewMediaItems(item).some((mediaItem) =>
    mediaItem.mediaKind === 'video' && !getShowcaseMediaPreviewUrl(mediaItem)
  );
}
