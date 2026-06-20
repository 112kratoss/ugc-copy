import type { VisualMediaKind } from '@/lib/media-contract';

export type MediaPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface VisualMediaDescriptor {
  id: string;
  kind: VisualMediaKind;
  url: string;
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
