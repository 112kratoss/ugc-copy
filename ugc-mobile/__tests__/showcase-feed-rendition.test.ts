import { describe, expect, it } from 'vitest';

import {
  getShowcaseFeedStreamUrl,
  getShowcasePlaybackUrl,
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

describe('showcase playback source', () => {
  it('streams the rendition when one exists', () => {
    const item = mediaItem({ renditionUrl: 'https://cdn.test/showcase/clip.feed.abc.mp4' });

    expect(getShowcasePlaybackUrl(item)).toBe('https://cdn.test/showcase/clip.feed.abc.mp4');
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

    expect(getShowcasePlaybackUrl(item)).toBe('https://cdn.test/descriptor.mp4');
  });

  it('falls back to the source for posts published before renditions existed', () => {
    // Old clients and old rows simply have no rendition; playback must not break.
    expect(getShowcasePlaybackUrl(mediaItem())).toBe('https://cdn.test/showcase/clip.mp4');
    expect(getShowcasePlaybackUrl(mediaItem({ renditionUrl: null })))
      .toBe('https://cdn.test/showcase/clip.mp4');
  });

  it('reports the raw rendition as null when absent so callers can tell', () => {
    expect(getShowcaseMediaRenditionUrl(mediaItem())).toBeNull();
    expect(getShowcaseMediaRenditionUrl(mediaItem({ renditionUrl: 'https://cdn.test/r.mp4' })))
      .toBe('https://cdn.test/r.mp4');
  });

  it('leaves the source url intact for downloads and remixes', () => {
    const item = mediaItem({ renditionUrl: 'https://cdn.test/showcase/clip.feed.abc.mp4' });

    // Playback surfaces — the feed row and the immersive viewer alike — take
    // the rendition. `url` stays reachable for the paths where full quality is
    // the point, so resolving playback must never overwrite it.
    expect(item.url).toBe('https://cdn.test/showcase/clip.mp4');
    expect(getShowcasePlaybackUrl(item)).not.toBe(item.url);
  });
});

describe('showcase feed stream source', () => {
  it('obeys the server decision, including an explicit poster-only null', () => {
    expect(getShowcaseFeedStreamUrl(mediaItem({
      feedStreamUrl: 'https://cdn.test/clip.teaser.abc.mp4',
      renditionUrl: 'https://cdn.test/clip.feed.abc.mp4',
    }))).toBe('https://cdn.test/clip.teaser.abc.mp4');

    // Null is a verdict, not an absence: the server decided poster-only and
    // the client must not fall back past it — that fallback is how raw
    // sources reached the feed in the first place.
    expect(getShowcaseFeedStreamUrl(mediaItem({
      feedStreamUrl: null,
      renditionUrl: 'https://cdn.test/clip.feed.abc.mp4',
      teaserUrl: 'https://cdn.test/clip.teaser.abc.mp4',
    }))).toBeNull();
  });

  it('falls back teaser-then-rendition only when the field is absent entirely', () => {
    // Older servers never send feedStreamUrl at all.
    expect(getShowcaseFeedStreamUrl(mediaItem({
      teaserUrl: 'https://cdn.test/clip.teaser.abc.mp4',
      renditionUrl: 'https://cdn.test/clip.feed.abc.mp4',
    }))).toBe('https://cdn.test/clip.teaser.abc.mp4');

    expect(getShowcaseFeedStreamUrl(mediaItem({
      renditionUrl: 'https://cdn.test/clip.feed.abc.mp4',
    }))).toBe('https://cdn.test/clip.feed.abc.mp4');
  });

  it('never returns the raw source, unlike the viewer helper', () => {
    const bare = mediaItem();

    // Same item, two verdicts: the viewer may stream the source deliberately,
    // the feed goes poster-only.
    expect(getShowcasePlaybackUrl(bare)).toBe(bare.url);
    expect(getShowcaseFeedStreamUrl(bare)).toBeNull();
  });
});
