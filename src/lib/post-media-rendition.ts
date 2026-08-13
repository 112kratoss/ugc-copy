import type { SupabaseClient } from '@supabase/supabase-js';

import { getMediaContentHash } from '@/lib/media-preview-metadata';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import {
  createVideoRenditionFromFile,
  createVideoTeaserFromFile,
  probeVideoFile,
  RENDITION_CONTENT_TYPE,
  TEASER_MIN_SOURCE_SECONDS,
  VideoRenditionSkipped,
  withVideoInputFile,
  type VideoProbeResult,
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

/**
 * Reported through `onTeaserOutcome` mid-attempt, because the teaser must
 * survive outcomes that end the attempt itself: a full-rendition timeout is a
 * throw, and a `not-smaller` source is a skip, but in both cases a teaser may
 * already be uploaded and recorded.
 */
export type PostMediaTeaserOutcome =
  | { status: 'ready'; teaserStoragePath: string; teaserBytes: number }
  | { status: 'failed'; error: string }
  | { status: 'not-needed' };

export function buildPostMediaRenditionPath(storagePath: string, contentHash: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.feed.${contentHash}.mp4`;
}

export function buildPostMediaTeaserPath(storagePath: string, contentHash: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.teaser.${contentHash}.mp4`;
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
 *
 * Mid-flight results travel through callbacks rather than the return value:
 * the input probe and the teaser both happen before the full transcode, and
 * both must reach the caller even when that transcode then times out (throw)
 * or skips. The caller merges them into whichever terminal update it takes.
 */
export async function createPostMediaRendition({
  body,
  contentType,
  storagePath,
  supabase,
  existingTeaserPath,
  onInputProbe,
  onTeaserOutcome,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
  /** A truthy value skips teaser work — content-hashed teasers never go stale. */
  existingTeaserPath?: string | null;
  onInputProbe?: (probe: VideoProbeResult) => void;
  onTeaserOutcome?: (outcome: PostMediaTeaserOutcome) => void;
}): Promise<PostMediaRenditionOutcome> {
  const resolvedContentType = contentType || body.type;
  if (!isRenditionEligibleVideo(resolvedContentType, storagePath)) {
    return { status: 'skipped', reason: 'not-video' };
  }

  try {
    return await withVideoInputFile(body, async (inputPath, sourceBytes) => {
      const inputProbe = await probeVideoFile(inputPath);
      onInputProbe?.(inputProbe);

      // Teaser first: an 8s transcode never approaches the ffmpeg timeout, so
      // it lands even when the full rendition of a long source dies. A teaser
      // failure is reported, never thrown — it must not consume the attempt.
      if (existingTeaserPath) {
        onTeaserOutcome?.({ status: 'not-needed' });
      } else if (
        inputProbe.durationSeconds !== null
        && inputProbe.durationSeconds > TEASER_MIN_SOURCE_SECONDS
      ) {
        try {
          const teaser = await createVideoTeaserFromFile(inputPath);
          const teaserStoragePath = buildPostMediaTeaserPath(
            storagePath,
            getMediaContentHash(teaser.buffer),
          );
          const teaserUpload = await supabase.storage
            .from(SHOWCASE_MEDIA_BUCKET)
            .upload(teaserStoragePath, teaser.buffer, {
              cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
              contentType: RENDITION_CONTENT_TYPE,
              upsert: true,
            });
          if (teaserUpload.error) {
            throw teaserUpload.error;
          }
          onTeaserOutcome?.({ status: 'ready', teaserStoragePath, teaserBytes: teaser.bytes });
        } catch (teaserError) {
          onTeaserOutcome?.({
            status: 'failed',
            error: teaserError instanceof Error ? teaserError.message : String(teaserError),
          });
        }
      } else {
        onTeaserOutcome?.({ status: 'not-needed' });
      }

      const rendition = await createVideoRenditionFromFile(inputPath, sourceBytes);

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
      } satisfies PostMediaRenditionOutcome;
    });
  } catch (error) {
    if (error instanceof VideoRenditionSkipped) {
      return { status: 'skipped', reason: error.reason };
    }
    throw error;
  }
}
