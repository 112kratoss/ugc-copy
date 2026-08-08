import { describe, expect, it } from 'vitest';

import { resolvePlaybackUrl } from '@/lib/media-descriptor';

const SOURCE = 'https://cdn.example/showcase/clip.mp4';
const RENDITION = 'https://cdn.example/showcase/clip.feed.abc123.mp4';

describe('resolvePlaybackUrl', () => {
  it('streams the rendition when one exists', () => {
    expect(resolvePlaybackUrl({ url: SOURCE, renditionUrl: RENDITION })).toBe(RENDITION);
  });

  it('falls back to the source when no rendition has been produced', () => {
    // Posts published before the rendition pipeline, ones that legitimately
    // skipped it, and legacy rows that carry no post_media row at all.
    expect(resolvePlaybackUrl({ url: SOURCE, renditionUrl: null })).toBe(SOURCE);
    expect(resolvePlaybackUrl({ url: SOURCE, renditionUrl: undefined })).toBe(SOURCE);
    expect(resolvePlaybackUrl({ url: SOURCE })).toBe(SOURCE);
  });

  it('treats an empty rendition URL as absent rather than playing nothing', () => {
    expect(resolvePlaybackUrl({ url: SOURCE, renditionUrl: '' })).toBe(SOURCE);
  });
});
