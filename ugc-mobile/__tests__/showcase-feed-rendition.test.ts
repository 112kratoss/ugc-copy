import { describe, expect, it } from 'vitest';

import {
  getShowcaseFeedPlaybackUrl,
  getShowcaseMediaRenditionUrl,
} from '@/lib/showcase-media';
import type { ShowcaseMediaItem } from '@/lib/types';

function mediaItem(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.test/showcase/clip.mp4',
    mediaKind: 'video',
    contentType: 'video/mp4',
    originalName: 'clip.mp4',
    width: 656,
    height: 1376,
    durationSeconds: 11.4,
    sortOrder: 0,
    ...overrides,
  };
}

describe('showcase feed playback source', () => {
  it('streams the rendition when one exists', () => {
    const item = mediaItem({ renditionUrl: 'https://cdn.test/showcase/clip.feed.abc.mp4' });

    expect(getShowcaseFeedPlaybackUrl(item)).toBe('https://cdn.test/showcase/clip.feed.abc.mp4');
  });

  it('prefers the descriptor rendition over the flat field', () => {
    const item = mediaItem({
      renditionUrl: 'https://cdn.test/flat.mp4',
      preview: {
        id: 'media-1',
        kind: 'video',
        url: 'https://cdn.test/showcase/clip.mp4',
        renditionUrl: 'https://cdn.test/descriptor.mp4',
        previewUrl: null,
        thumbhash: null,
        cacheKey: 'media-1',
        expiresAt: null,
        width: null,
        height: null,
        durationSeconds: null,
        status: 'ready',
        gridReady: false,
      },
    });

    expect(getShowcaseFeedPlaybackUrl(item)).toBe('https://cdn.test/descriptor.mp4');
  });

  it('falls back to the source for posts published before renditions existed', () => {
    // Old clients and old rows simply have no rendition; playback must not break.
    expect(getShowcaseFeedPlaybackUrl(mediaItem())).toBe('https://cdn.test/showcase/clip.mp4');
    expect(getShowcaseFeedPlaybackUrl(mediaItem({ renditionUrl: null })))
      .toBe('https://cdn.test/showcase/clip.mp4');
  });

  it('reports the raw rendition as null when absent so callers can tell', () => {
    expect(getShowcaseMediaRenditionUrl(mediaItem())).toBeNull();
    expect(getShowcaseMediaRenditionUrl(mediaItem({ renditionUrl: 'https://cdn.test/r.mp4' })))
      .toBe('https://cdn.test/r.mp4');
  });

  it('never returns the rendition for the full-quality source url', () => {
    const item = mediaItem({ renditionUrl: 'https://cdn.test/showcase/clip.feed.abc.mp4' });

    // The viewer and downloads must keep getting the original.
    expect(item.url).toBe('https://cdn.test/showcase/clip.mp4');
    expect(getShowcaseFeedPlaybackUrl(item)).not.toBe(item.url);
  });
});
