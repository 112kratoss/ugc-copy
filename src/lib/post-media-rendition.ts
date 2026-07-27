import type { SupabaseClient } from '@supabase/supabase-js';

import { getMediaContentHash } from '@/lib/media-preview-metadata';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import {
  createVideoRenditionBuffer,
  RENDITION_CONTENT_TYPE,
  VideoRenditionSkipped,
} from '@/lib/video-rendition';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

export type PostMediaRenditionStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'skipped';

export type PostMediaRenditionOutcome =
  | {
      status: 'ready';
      renditionStoragePath: string;
      renditionBytes: number;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
    }
  | {
      status: 'skipped';
      reason: 'not-video' | 'too-large' | 'not-smaller';
    };

export function buildPostMediaRenditionPath(storagePath: string, contentHash: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.feed.${contentHash}.mp4`;
}

export function isRenditionEligibleVideo(
  contentType: string | null | undefined,
  storagePath: string,
): boolean {
  return Boolean(contentType?.startsWith('video/'))
    || /\.(m4v|mov|mp4|webm)$/i.test(storagePath);
}

/**
 * Build the small copy the showcase feed autoplays and upload it beside the
 * source. Returns a `skipped` outcome — not a throw — when a rendition would
 * not help, so callers can record that terminally instead of retrying forever.
 */
export async function createPostMediaRendition({
  body,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}): Promise<PostMediaRenditionOutcome> {
  const resolvedContentType = contentType || body.type;
  if (!isRenditionEligibleVideo(resolvedContentType, storagePath)) {
    return { status: 'skipped', reason: 'not-video' };
  }

  let rendition;
  try {
    rendition = await createVideoRenditionBuffer(body);
  } catch (error) {
    if (error instanceof VideoRenditionSkipped) {
      return { status: 'skipped', reason: error.reason };
    }
    throw error;
  }

  const renditionStoragePath = buildPostMediaRenditionPath(
    storagePath,
    getMediaContentHash(rendition.buffer),
  );
  const upload = await supabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .upload(renditionStoragePath, rendition.buffer, {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: RENDITION_CONTENT_TYPE,
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  return {
    status: 'ready',
    renditionStoragePath,
    renditionBytes: rendition.bytes,
    width: rendition.width,
    height: rendition.height,
    durationSeconds: rendition.durationSeconds,
  };
}
