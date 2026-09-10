import { describe, expect, it } from 'vitest';

import {
  getShowcaseViewerImageCacheKey,
  getShowcaseViewerImageUrl,
  resolveShowcaseImageTileSource,
} from '@/lib/showcase-media';
import type { ShowcaseMediaItem } from '@/lib/types';

function imageMedia(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.example.com/full-resolution.jpg',
    previewUrl: 'https://cdn.example.com/preview.webp',
    previewThumbhash: null,
    previewCacheKey: 'preview-key',
    gridReady: true,
    mediaKind: 'image',
    contentType: 'image/jpeg',
    originalName: 'full-resolution.jpg',
    width: 2048,
    height: 2048,
    durationSeconds: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe('showcase image tile source resolution', () => {
  it('never caches a full-size viewer image under its thumbnail key', () => {
    const item = imageMedia();
    expect(getShowcaseViewerImageCacheKey(item)).toBe('preview-key:source');
    expect(getShowcaseViewerImageCacheKey({ ...item, preview: {
      id: item.id, kind: 'image', url: item.url, previewUrl: item.previewUrl!,
      cacheKey: 'descriptor-poster', thumbhash: null, expiresAt: null,
      width: 720, height: 720, durationSeconds: null, status: 'ready', gridReady: true,
    } })).toBe('descriptor-poster:source');
  });

  it('retains the existing key when the preview is the original image', () => {
    const item = imageMedia();
    expect(getShowcaseViewerImageCacheKey({ ...item, previewUrl: item.url })).toBe('preview-key');
    expect(getShowcaseViewerImageCacheKey({ ...item, previewCacheKey: undefined })).toBeUndefined();
  });

  // The viewer used to load the source, which made images the largest share of
  // Storage egress. The display rendition is what it should reach for.
  it('prefers the display rendition over the source, under its own cache key', () => {
    const item = imageMedia({ displayUrl: 'https://cdn.example.com/full.display.abc.webp' });
    expect(getShowcaseViewerImageUrl(item)).toBe('https://cdn.example.com/full.display.abc.webp');
    expect(getShowcaseViewerImageCacheKey(item)).toBe('preview-key:display');
  });

  it('falls back to the source when no display rendition was worth storing', () => {
    const item = imageMedia({ displayUrl: null });
    expect(getShowcaseViewerImageUrl(item)).toBe(item.url);
    expect(getShowcaseViewerImageCacheKey(item)).toBe('preview-key:source');
  });

  it('uses a ready preview before considering the source image', () => {
    expect(resolveShowcaseImageTileSource(imageMedia(), null)).toBe('preview');
  });

  it('allows the source only after an existing preview fails', () => {
    const item = imageMedia();

    expect(resolveShowcaseImageTileSource(item, item.previewUrl ?? null)).toBe('source-fallback');
  });

  it('keeps a missing preview pending and never selects the full-resolution source', () => {
    expect(resolveShowcaseImageTileSource(imageMedia({
      previewUrl: null,
      previewStatus: 'processing',
      gridReady: false,
    }), null)).toBe('pending');
  });

  it('keeps a failed missing derivative on the lightweight placeholder', () => {
    expect(resolveShowcaseImageTileSource(imageMedia({
      previewUrl: null,
      previewStatus: 'failed',
      gridReady: false,
    }), null)).toBe('pending');
  });

  it('does not fetch legacy full-resolution images when no preview URL exists', () => {
    expect(resolveShowcaseImageTileSource(imageMedia({
      previewUrl: null,
      previewStatus: undefined,
      gridReady: false,
    }), null)).toBe('pending');
  });
});
