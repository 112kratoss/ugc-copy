import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildMediaProxyUrl,
  isMediaBucket,
  type MediaBucket,
} from '@/lib/media-urls';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

type BucketPathGroup = Map<string, string[]>;

function getSafeRemoteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.pathname.includes('/storage/v1/object/')
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a page of user-owned media paths with one Storage request per bucket.
 * Every owned local path is prefilled with the same-origin proxy as a safe
 * fallback, then replaced by a signed URL when batch signing succeeds.
 */
export async function resolveOwnedStoredMediaUrlMap(params: {
  supabase: SupabaseClient;
  outputUrls: Iterable<string | null | undefined>;
  ownerUserIds: Iterable<string>;
  expiresIn?: number;
}): Promise<Map<string, string | null>> {
  const resolvedUrls = new Map<string, string | null>();
  const pathsByBucket = new Map<MediaBucket, BucketPathGroup>();
  const ownerUserIds = Array.from(new Set(
    Array.from(params.ownerUserIds).filter((value) => typeof value === 'string' && value.length > 0),
  ));

  for (const outputUrl of new Set(Array.from(params.outputUrls).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ))) {
    const location = ownerUserIds
      .map((ownerUserId) => getUserOwnedStoredMediaLocation(outputUrl, ownerUserId, {
        allowedBuckets: [
          'generated_images',
          'generated_videos',
          'generated_audio',
          'generation_inputs',
        ],
      }))
      .find((candidate) => candidate !== null) ?? null;
    if (!location) {
      const remoteUrl = getSafeRemoteUrl(outputUrl);
      if (!remoteUrl) {
        logBackendError('refused_to_sign_media_outside_owner_prefix', {
          message: `Refused to sign media outside owner prefix: ${outputUrl}`,
        });
      }
      resolvedUrls.set(outputUrl, remoteUrl);
      continue;
    }
    if (!isMediaBucket(location.bucket)) {
      resolvedUrls.set(outputUrl, null);
      continue;
    }

    resolvedUrls.set(outputUrl, buildMediaProxyUrl(location.bucket, location.filePath));
    const pathGroup = pathsByBucket.get(location.bucket) ?? new Map<string, string[]>();
    const sourceUrls = pathGroup.get(location.filePath) ?? [];
    sourceUrls.push(outputUrl);
    pathGroup.set(location.filePath, sourceUrls);
    pathsByBucket.set(location.bucket, pathGroup);
  }

  await Promise.all(Array.from(pathsByBucket, async ([bucket, pathGroup]) => {
    const paths = Array.from(pathGroup.keys());

    try {
      const { data, error } = await params.supabase.storage
        .from(bucket)
        .createSignedUrls(paths, params.expiresIn ?? 3600);

      if (error || !data) {
        logBackendError('failed_to_batch_sign_media_urls_for', { message: `Failed to batch-sign media URLs for ${bucket}:`, error: error });
        return;
      }

      data.forEach((result, index) => {
        const filePath = result.path ?? paths[index];
        if (!filePath || result.error || !result.signedUrl) {
          logBackendError('failed_to_sign_media_url_for', { message: `Failed to sign media URL for ${bucket}/${filePath ?? 'unknown'}:`, error: result.error, });
          return;
        }

        for (const sourceUrl of pathGroup.get(filePath) ?? []) {
          resolvedUrls.set(sourceUrl, result.signedUrl);
        }
      });
    } catch (error) {
      logBackendError('failed_to_batch_sign_media_urls_for', { message: `Failed to batch-sign media URLs for ${bucket}:`, error: error });
    }
  }));

  return resolvedUrls;
}
