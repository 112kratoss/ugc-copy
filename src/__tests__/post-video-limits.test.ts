import { describe, expect, it } from 'vitest';

import {
  POST_VIDEO_DURATION_LIMIT_MESSAGE,
  POST_VIDEO_MAX_DURATION_SECONDS,
  POST_VIDEO_MAX_UPLOAD_BYTES,
  resolvePostVideoFeedStreamUrl,
} from '@/lib/post-video-limits';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/temporary-media-upload-sign';

describe('post video limits', () => {
  it('keeps the client-safe byte mirror aligned with the signing service', () => {
    // post-video-limits.ts is imported by browser components, so it cannot
    // import the signing module (node:crypto) and mirrors the value instead.
    expect(POST_VIDEO_MAX_UPLOAD_BYTES).toBe(MAX_UPLOAD_BYTES_BY_KIND.video);
  });

  it('pins the ceiling and its user-facing copy', () => {
    expect(POST_VIDEO_MAX_DURATION_SECONDS).toBe(600);
    // The mobile composer pins the identical sentence against its own mirrored
    // constant (ugc-mobile/__tests__/media-upload.test.ts), which keeps the
    // two clients' copy in lockstep.
    expect(POST_VIDEO_DURATION_LIMIT_MESSAGE).toBe('Videos must be 10 minutes or shorter.');
  });
});

describe('feed stream policy', () => {
  const base = {
    url: 'https://cdn.example.com/source.mp4',
    renditionUrl: 'https://cdn.example.com/source.feed.abc.mp4',
    teaserUrl: null as string | null,
    renditionStatus: 'ready' as const,
    durationSeconds: 12,
  };

  it('prefers the teaser so long-video feed egress is bounded at 8s', () => {
    expect(resolvePostVideoFeedStreamUrl({
      ...base,
      teaserUrl: 'https://cdn.example.com/source.teaser.abc.mp4',
      durationSeconds: 95,
    })).toBe('https://cdn.example.com/source.teaser.abc.mp4');
  });

  it('streams the rendition for normal clips', () => {
    expect(resolvePostVideoFeedStreamUrl(base)).toBe(base.renditionUrl);
  });

  it('never lets a raw source autoplay just because the rendition failed', () => {
    // This exact fallback (renditionUrl ?? url) was the egress amplifier: a
    // long video fails its transcode and then streams at full fat forever.
    expect(resolvePostVideoFeedStreamUrl({
      ...base,
      renditionUrl: null,
      renditionStatus: 'failed',
    })).toBeNull();
    expect(resolvePostVideoFeedStreamUrl({
      ...base,
      renditionUrl: null,
      renditionStatus: 'pending',
    })).toBeNull();
  });

  it('allows the source only for skipped videos, the provably lean class', () => {
    // 'skipped' on a real video row means not-smaller: the 512MB too-large
    // skip cannot occur through uploads (bucket caps objects at 250MB).
    expect(resolvePostVideoFeedStreamUrl({
      ...base,
      renditionUrl: null,
      renditionStatus: 'skipped',
    })).toBe(base.url);
  });

  it('goes poster-only for an over-ceiling video without a teaser', () => {
    expect(resolvePostVideoFeedStreamUrl({
      ...base,
      durationSeconds: POST_VIDEO_MAX_DURATION_SECONDS + 1,
    })).toBeNull();
  });
});
