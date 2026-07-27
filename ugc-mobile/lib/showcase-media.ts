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
 * that need a guaranteed URL should use getShowcaseFeedPlaybackUrl.
 */
export function getShowcaseMediaRenditionUrl(item: ShowcaseMediaItem): string | null {
  return item.preview?.renditionUrl ?? item.renditionUrl ?? null;
}

/**
 * What an autoplaying feed row should stream. Prefers the small rendition and
 * falls back to the source, so posts published before the rendition pipeline —
 * and ones that legitimately skipped it — still play.
 *
 * Only for muted, scroll-by playback. The full viewer must keep using `url`.
 */
export function getShowcaseFeedPlaybackUrl(item: ShowcaseMediaItem): string {
  return getShowcaseMediaRenditionUrl(item) ?? item.url;
}

export function hasShowcaseVideoWithoutPreview(item: ShowcaseFeedItem) {
  return getShowcasePreviewMediaItems(item).some((mediaItem) =>
    mediaItem.mediaKind === 'video' && !getShowcaseMediaPreviewUrl(mediaItem)
  );
}
