import { describe, expect, it } from 'vitest';

import {
  buildRenditionArgs,
  buildRenditionScaleFilter,
  parseVideoProbeOutput,
  RENDITION_MAX_HEIGHT,
  RENDITION_MAX_WIDTH,
  RENDITION_MIN_SAVING_RATIO,
  TEASER_MIN_SOURCE_SECONDS,
  TEASER_SECONDS,
  VideoRenditionSkipped,
} from '@/lib/video-rendition';
import {
  buildPostMediaRenditionPath,
  buildPostMediaTeaserPath,
  isRenditionEligibleVideo,
} from '@/lib/post-media-rendition';

describe('rendition ffmpeg arguments', () => {
  const args = buildRenditionArgs('/tmp/in.mp4', '/tmp/out.mp4');
  const argString = args.join(' ');

  it('streams progressively by moving the moov atom to the front', () => {
    // Without faststart the player must download the whole file before the
    // first frame, which defeats the point of a feed rendition.
    expect(argString).toContain('-movflags +faststart');
  });

  it('maps the video stream explicitly and tolerates a missing audio track', () => {
    // Provider output does not reliably place video on stream 0.
    expect(args).toContain('0:v:0');
    expect(args).toContain('0:a:0?');
  });

  it('caps bitrate as well as quality', () => {
    // CRF alone leaves a pathologically over-encoded source huge; the ceiling
    // is what actually bounds the worst case.
    expect(argString).toContain('-crf 30');
    expect(argString).toContain('-maxrate 1400k');
    expect(argString).toContain('-bufsize 2800k');
  });

  it('encodes broadly playable H.264 and keeps loops seekable', () => {
    expect(argString).toContain('-c:v libx264');
    expect(argString).toContain('-profile:v main');
    expect(argString).toContain('-pix_fmt yuv420p');
    expect(argString).toContain('-g 60');
  });

  it('puts the output path last and overwrites without prompting', () => {
    expect(args[0]).toBe('-y');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
  });
});

describe('teaser ffmpeg arguments', () => {
  const teaserArgs = buildRenditionArgs('/tmp/in.mp4', '/tmp/teaser.mp4', {
    maxDurationSeconds: TEASER_SECONDS,
    stripAudio: true,
  });
  const teaserArgString = teaserArgs.join(' ');

  it('trims to the teaser length', () => {
    expect(teaserArgString).toContain(`-t ${TEASER_SECONDS}`);
  });

  it('drops the audio stream entirely — the feed always plays muted', () => {
    expect(teaserArgs).toContain('-an');
    expect(teaserArgs).not.toContain('0:a:0?');
    expect(teaserArgString).not.toContain('-c:a');
  });

  it('keeps the encode ladder and faststart of the full rendition', () => {
    expect(teaserArgString).toContain('-c:v libx264');
    expect(teaserArgString).toContain('-maxrate 1400k');
    expect(teaserArgString).toContain('-movflags +faststart');
  });

  it('pins the thresholds the sweep gates teaser work on', () => {
    expect(TEASER_MIN_SOURCE_SECONDS).toBe(30);
    expect(TEASER_SECONDS).toBe(8);
  });
});

describe('rendition scale filter', () => {
  const filter = buildRenditionScaleFilter();

  it('clamps the target to the source so small videos are never upscaled', () => {
    expect(filter).toContain(`min(${RENDITION_MAX_WIDTH},iw)`);
    expect(filter).toContain(`min(${RENDITION_MAX_HEIGHT},ih)`);
  });

  it('preserves aspect ratio and keeps dimensions even for yuv420p', () => {
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(filter).toContain('force_divisible_by=2');
  });
});

describe('probing ffmpeg stderr', () => {
  // Verbatim ffmpeg output for a real showcase clip, audio listed before video.
  const portraitOutput = `
  Duration: 00:00:11.40, start: 0.000000, bitrate: 23741 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:1[0x2](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(progressive), 656x1376, 23604 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
`;

  it('reads duration including fractional seconds', () => {
    expect(parseVideoProbeOutput(portraitOutput).durationSeconds).toBe(11.4);
  });

  it('finds the video stream even when audio is listed first', () => {
    const probe = parseVideoProbeOutput(portraitOutput);
    expect(probe.width).toBe(656);
    expect(probe.height).toBe(1376);
  });

  it('does not mistake a display-aspect hint for the frame size', () => {
    const landscape = `
  Duration: 00:00:37.97, start: 0.000000, bitrate: 2452 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 2315 kb/s, 30 fps
`;
    const probe = parseVideoProbeOutput(landscape);
    // 16x9 inside the bracket must not win over 1280x720.
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
  });

  it('returns nulls rather than throwing on unparseable output', () => {
    expect(parseVideoProbeOutput('ffmpeg: command failed')).toEqual({
      width: null,
      height: null,
      durationSeconds: null,
    });
  });

  it('handles durations past an hour', () => {
    expect(parseVideoProbeOutput('  Duration: 01:02:03.50,').durationSeconds).toBe(3723.5);
  });
});

describe('rendition skip signalling', () => {
  it('carries a machine-readable reason so callers can record it terminally', () => {
    const skipped = new VideoRenditionSkipped('too-large', 'Source video is too large.');
    expect(skipped).toBeInstanceOf(Error);
    expect(skipped.reason).toBe('too-large');
  });

  it('only keeps a rendition that is meaningfully smaller', () => {
    expect(RENDITION_MIN_SAVING_RATIO).toBeLessThan(1);
    // A 32 MB source transcoded to 2 MB is worth storing; 31.9 MB is not.
    expect(2_031_616 < 33_831_055 * RENDITION_MIN_SAVING_RATIO).toBe(true);
    expect(33_400_000 < 33_831_055 * RENDITION_MIN_SAVING_RATIO).toBe(false);
  });
});

describe('rendition storage paths', () => {
  it('sits beside the source and is content-addressed', () => {
    expect(buildPostMediaRenditionPath('posts/abc/0/clip.mp4', 'deadbeef'))
      .toBe('posts/abc/0/clip.feed.deadbeef.mp4');
  });

  it('always lands on .mp4 regardless of the source container', () => {
    expect(buildPostMediaRenditionPath('showcase/abc/clip.mov', 'cafe1234'))
      .toBe('showcase/abc/clip.feed.cafe1234.mp4');
    expect(buildPostMediaRenditionPath('showcase/abc/clip.webm', 'cafe1234'))
      .toBe('showcase/abc/clip.feed.cafe1234.mp4');
  });

  it('does not mistake a dot in a directory name for an extension', () => {
    expect(buildPostMediaRenditionPath('posts/v1.2/clip', 'abc123'))
      .toBe('posts/v1.2/clip.feed.abc123.mp4');
  });

  it('never collides with the preview object for the same source', () => {
    const source = 'posts/abc/0/clip.mp4';
    expect(buildPostMediaRenditionPath(source, 'abc123'))
      .not.toBe(`${source.slice(0, -4)}.preview.abc123.webp`);
  });

  it('gives the teaser its own content-addressed object beside the rendition', () => {
    expect(buildPostMediaTeaserPath('posts/abc/0/clip.mp4', 'deadbeef'))
      .toBe('posts/abc/0/clip.teaser.deadbeef.mp4');
    // Distinct infix: the same source must be able to hold both objects.
    expect(buildPostMediaTeaserPath('posts/abc/0/clip.mp4', 'deadbeef'))
      .not.toBe(buildPostMediaRenditionPath('posts/abc/0/clip.mp4', 'deadbeef'));
  });
});

describe('rendition eligibility', () => {
  it('accepts video by content type', () => {
    expect(isRenditionEligibleVideo('video/mp4', 'posts/a/clip')).toBe(true);
    expect(isRenditionEligibleVideo('video/quicktime', 'posts/a/clip')).toBe(true);
  });

  it('falls back to the extension when the content type is missing', () => {
    expect(isRenditionEligibleVideo(null, 'posts/a/clip.mp4')).toBe(true);
    expect(isRenditionEligibleVideo(undefined, 'posts/a/clip.MOV')).toBe(true);
    expect(isRenditionEligibleVideo(null, 'posts/a/clip.webm')).toBe(true);
  });

  it('rejects images so they never reach ffmpeg', () => {
    expect(isRenditionEligibleVideo('image/png', 'posts/a/shot.png')).toBe(false);
    expect(isRenditionEligibleVideo(null, 'posts/a/shot.webp')).toBe(false);
  });
});
