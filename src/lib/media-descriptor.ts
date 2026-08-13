import type { VisualMediaKind } from '@/lib/media-contract';

export type MediaPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface VisualMediaDescriptor {
  id: string;
  kind: VisualMediaKind;
  url: string;
  /**
   * Small faststart copy, streamed by every surface that plays the clip. Null
   * when none exists yet or the source was already lean enough. `url` stays the
   * source of record, and is what downloads and remixes must use.
   */
  renditionUrl: string | null;
  /**
   * 8s muted head of a long clip, encoded so the feed can autoplay a bounded
   * amount of a video whose full length would be pure egress. Feed-only —
   * viewers keep streaming the rendition.
   */
  teaserUrl: string | null;
  /**
   * The server-computed decision of what an autoplaying feed card may stream:
   * teaser, rendition, source (only when provably lean), or null for
   * poster-only. Clients should not re-derive this.
   */
  feedStreamUrl: string | null;
  previewUrl: string | null;
  thumbhash: string | null;
  cacheKey: string;
  expiresAt: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  status: MediaPreviewStatus;
  gridReady: boolean;
}

export function buildVisualMediaDescriptor(input: {
  id: string;
  kind: VisualMediaKind;
  url: string;
  storageKey: string;
  renditionUrl?: string | null;
  teaserUrl?: string | null;
  feedStreamUrl?: string | null;
  previewUrl: string | null;
  previewStorageKey: string | null;
  previewThumbhash: string | null;
  previewStatus: MediaPreviewStatus;
  expiresAt: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}): VisualMediaDescriptor {
  return {
    id: input.id,
    kind: input.kind,
    url: input.url,
    renditionUrl: input.renditionUrl ?? null,
    teaserUrl: input.teaserUrl ?? null,
    feedStreamUrl: input.feedStreamUrl ?? null,
    previewUrl: input.previewUrl,
    thumbhash: input.previewThumbhash,
    cacheKey: input.previewStorageKey || input.storageKey || input.id,
    expiresAt: input.expiresAt,
    width: input.width,
    height: input.height,
    durationSeconds: input.durationSeconds,
    status: input.previewStatus,
    gridReady: input.previewStatus === 'ready' && Boolean(input.previewUrl),
  };
}

/**
 * What any surface that plays a clip should stream — the autoplaying feed, the
 * detail and reel viewers, and profile hover previews alike. Prefers the
 * rendition and falls back to the source, so posts published before the
 * rendition pipeline (or ones that legitimately skipped it) still play.
 *
 * The viewers deliberately streamed `url` for full quality until the 2026-08
 * scaling audit measured the cost: sources run ~23 Mbps against a 720p/1.4 Mbps
 * rendition, and the watch surfaces account for 80-90% of all storage egress.
 * `url` stays the source of record for downloads and remixes, where full
 * quality is the point.
 */
export function resolvePlaybackUrl(media: {
  url: string;
  renditionUrl?: string | null;
}): string {
  return media.renditionUrl || media.url;
}
