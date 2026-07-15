import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildMediaProxyUrl,
  getStoredMediaLocation,
  type MediaBucket,
} from '@/lib/media-urls';
import { isStorageObjectOwnedByUser } from '@/lib/storage-ownership';

type BucketPathGroup = Map<string, string[]>;

function getSafeRemoteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
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
  ownerUserId: string;
  expiresIn?: number;
}): Promise<Map<string, string | null>> {
  const resolvedUrls = new Map<string, string | null>();
  const pathsByBucket = new Map<MediaBucket, BucketPathGroup>();

  for (const outputUrl of new Set(Array.from(params.outputUrls).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ))) {
    const location = getStoredMediaLocation(outputUrl);
    if (!location) {
      resolvedUrls.set(outputUrl, getSafeRemoteUrl(outputUrl));
      continue;
    }

    if (!isStorageObjectOwnedByUser(location.filePath, params.ownerUserId)) {
      console.error(`Refused to sign media outside owner prefix: ${location.bucket}/${location.filePath}`);
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
        console.error(`Failed to batch-sign media URLs for ${bucket}:`, error);
        return;
      }

      data.forEach((result, index) => {
        const filePath = result.path ?? paths[index];
        if (!filePath || result.error || !result.signedUrl) {
          console.error(
            `Failed to sign media URL for ${bucket}/${filePath ?? 'unknown'}:`,
            result.error,
          );
          return;
        }

        for (const sourceUrl of pathGroup.get(filePath) ?? []) {
          resolvedUrls.set(sourceUrl, result.signedUrl);
        }
      });
    } catch (error) {
      console.error(`Failed to batch-sign media URLs for ${bucket}:`, error);
    }
  }));

  return resolvedUrls;
}
