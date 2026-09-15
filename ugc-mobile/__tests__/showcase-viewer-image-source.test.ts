import { describe, expect, it } from 'vitest';

import { buildImmersiveGenerationItems } from '../lib/immersive-preview-view-model';
import { getShowcaseViewerImageCacheKey, resolveShowcaseViewerImageSource } from '../lib/showcase-media';
import type { GenerationListItem, ShowcaseMediaItem, VisualMediaDescriptor } from '../lib/types';

function media(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://storage.example.com/owner/original.png',
    previewUrl: 'https://storage.example.com/owner/preview.webp',
    previewCacheKey: 'owner/preview.webp',
    mediaKind: 'image',
    contentType: null,
    originalName: null,
    width: 720,
    height: 960,
    durationSeconds: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe('viewer image source', () => {
  it('opens the display rendition under its own cache entry', () => {
    const item = media({ displayUrl: 'https://storage.example.com/owner/display.webp' });

    expect(resolveShowcaseViewerImageSource(item)).toEqual({
      url: 'https://storage.example.com/owner/display.webp',
      cacheKey: 'owner/preview.webp:display',
      rendition: 'display',
    });
  });

  it('falls back to the original, under the original\'s entry, once the display object fails', () => {
    const item = media({ displayUrl: 'https://storage.example.com/owner/display.webp' });

    expect(resolveShowcaseViewerImageSource(item, item.displayUrl)).toEqual({
      url: 'https://storage.example.com/owner/original.png',
      cacheKey: 'owner/preview.webp:source',
      rendition: 'source',
    });
  });

  it('opens the original when no display rendition was stored', () => {
    expect(resolveShowcaseViewerImageSource(media({ displayUrl: null }))).toMatchObject({
      url: 'https://storage.example.com/owner/original.png',
      rendition: 'source',
    });
    expect(getShowcaseViewerImageCacheKey(media())).toBe('owner/preview.webp:source');
  });

  it('attaches a display rendition only to the output its descriptor describes', () => {
    const first = 'https://storage.example.com/owner/first.png';
    const second = 'https://storage.example.com/owner/second.png';
    const descriptor: VisualMediaDescriptor = {
      id: 'gen',
      kind: 'image',
      url: second,
      displayUrl: 'https://storage.example.com/owner/second.display.webp',
      previewUrl: 'https://storage.example.com/owner/second.preview.webp',
      thumbhash: null,
      cacheKey: 'owner/second.preview.webp',
      expiresAt: null,
      width: 720,
      height: 960,
      durationSeconds: null,
      status: 'ready',
      gridReady: true,
    };
    const generation: GenerationListItem = {
      id: 'gen',
      output_url: second,
      output_urls: [first, second],
      media: descriptor,
      status: 'succeeded',
      created_at: '2026-09-02T10:00:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
    };

    const [item] = buildImmersiveGenerationItems('profile-creations', [generation], { creatorLabel: '@owner' });

    expect(item.mediaItems[0]).not.toHaveProperty('displayUrl');
    expect(resolveShowcaseViewerImageSource(item.mediaItems[0]).url).toBe(first);
    expect(resolveShowcaseViewerImageSource(item.mediaItems[1]).url).toBe(descriptor.displayUrl);
  });
});
