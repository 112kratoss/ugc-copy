import type { VisualMediaKind } from '@/lib/media-contract';

export type MediaPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface VisualMediaDescriptor {
  id: string;
  kind: VisualMediaKind;
  url: string;
  /**
   * Small faststart copy for autoplaying surfaces (the showcase feed). Null
   * when none exists yet or the source was already lean enough. Never use it
   * where the user expects full quality — `url` stays the source of record.
   */
  renditionUrl: string | null;
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
 * What an autoplaying feed surface should stream. Prefers the rendition and
 * falls back to the source so posts published before the rendition pipeline
 * (or ones that legitimately skipped it) still play.
 */
export function resolveFeedPlaybackUrl(media: {
  url: string;
  renditionUrl?: string | null;
}): string {
  return media.renditionUrl || media.url;
}
