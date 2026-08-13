/**
 * Post video limits shared by the web composer and the publish services, and
 * mirrored by value in the mobile composer (ugc-mobile/lib/media.ts).
 *
 * Client checks are UX only: the composer refuses what it can measure before
 * any bytes are uploaded, publish re-checks the client-reported duration, and
 * the rendition sweep's ffmpeg probe of the actual file is the authoritative
 * boundary for anything that slips past both.
 *
 * This module must stay importable from client components — no server-only
 * dependencies.
 */
export const POST_VIDEO_MAX_DURATION_SECONDS = 600;

export const POST_VIDEO_DURATION_LIMIT_MESSAGE =
  `Videos must be ${POST_VIDEO_MAX_DURATION_SECONDS / 60} minutes or shorter.`;

/**
 * Mirrors MAX_UPLOAD_BYTES_BY_KIND.video in temporary-media-upload-sign.ts,
 * which cannot be imported from the browser (node:crypto). The agreement is
 * pinned by test. Checked in the composer so an oversized pick fails with a
 * clear message instead of a failed signed-upload round trip.
 */
export const POST_VIDEO_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export const POST_VIDEO_UPLOAD_BYTES_MESSAGE = 'Videos must be 250 MB or smaller.';

/**
 * THE feed-stream admission policy: decides, server-side, what an autoplaying
 * feed card may stream for a video — one place, so clients stay dumb and old
 * ones inherit fixes through the API rather than a store release.
 *
 * Inputs and what they mean:
 * - `teaserUrl` — 8s muted head; exists only for sources > 30s whose teaser
 *   encode landed. Path presence IS readiness (written post-upload only).
 * - `renditionUrl` — 720p/1.4Mbps full-length copy; non-null only when
 *   `renditionStatus === 'ready'`.
 * - `renditionStatus === 'skipped'` on a video means the source was already
 *   lean ('not-smaller'): the 512MB 'too-large' skip is unreachable through
 *   uploads because the bucket caps objects at 250MB. Streaming the source is
 *   therefore *safe* for skipped videos — this is the one case where `url`
 *   may autoplay.
 * - `durationSeconds` — client-reported until the sweep's input probe
 *   overwrites it; may be null for unprobed legacy rows.
 *
 * Trade-offs encoded here:
 * - Preferring the teaser over a ready rendition bounds feed egress to O(8s)
 *   for long videos even though the rendition exists (the viewer still gets
 *   the full rendition).
 * - Returning null (poster-only) rather than falling back to `url` is the
 *   whole fix: raw sources reached the feed precisely through that fallback.
 * - An over-ceiling duration with no teaser yields null rather than the
 *   rendition: a >10min video should not autoplay at all until its teaser
 *   exists, and its presence usually means the ceiling was bypassed.
 */
export function resolvePostVideoFeedStreamUrl(input: {
  url: string;
  renditionUrl: string | null;
  teaserUrl: string | null;
  renditionStatus: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped';
  durationSeconds: number | null;
}): string | null {
  if (input.teaserUrl) return input.teaserUrl;
  if (input.durationSeconds !== null && input.durationSeconds > POST_VIDEO_MAX_DURATION_SECONDS) {
    return null;
  }
  if (input.renditionUrl) return input.renditionUrl;
  if (input.renditionStatus === 'skipped') return input.url;
  return null;
}
