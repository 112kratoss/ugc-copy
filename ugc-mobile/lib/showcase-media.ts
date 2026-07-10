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

export function hasShowcaseVideoWithoutPreview(item: ShowcaseFeedItem) {
  return getShowcasePreviewMediaItems(item).some((mediaItem) =>
    mediaItem.mediaKind === 'video' && !getShowcaseMediaPreviewUrl(mediaItem)
  );
}
