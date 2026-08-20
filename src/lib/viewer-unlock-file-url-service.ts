import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getViewerUnlockDetail,
  listViewerUnlockStoragePaths,
} from '@/lib/viewer-unlock-detail';
import {
  getCanonicalStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const RESOURCE_SOURCE_BUCKETS = [
  RESOURCE_FILES_BUCKET,
  'uploads',
  'generation_inputs',
  'generated_images',
  'generated_videos',
  'generated_audio',
] as const;
const SIGNED_READ_EXPIRES_IN_SECONDS = 600;

export type ViewerUnlockFileUrlClient = SupabaseClient & Parameters<typeof enforceBackendRateLimit>[0];

export type ViewerUnlockFileUrlResult =
  | { ok: true; body: { success: true; signedUrl: string } }
  | { ok: false; status: 400 | 404 | 500; body: { error: string } }
  | { ok: false; rateLimitError: BackendRateLimitError };

function parseRequestedPath(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const value = (body as Record<string, unknown>).storagePath;
  return typeof value === 'string' && value === value.trim() ? value : '';
}

export function resolvePostResourceStorageLocation(
  storagePath: string,
  ownerUserId?: string | null,
) {
  const storedLocation = getCanonicalStoredMediaLocation(storagePath, {
    allowedBuckets: RESOURCE_SOURCE_BUCKETS,
    ...(ownerUserId ? { ownerUserId } : {}),
  });
  if (storedLocation) return storedLocation;

  const filePath = parseCanonicalStorageObjectPath(storagePath, {
    ...(ownerUserId ? { ownerUserId } : {}),
  });
  return filePath ? { bucket: RESOURCE_FILES_BUCKET, filePath } : null;
}

function resolveRetainedStorageLocation(
  revisionId: string,
  bucket: unknown,
  filePath: unknown,
) {
  if (bucket !== RESOURCE_FILES_BUCKET || typeof filePath !== 'string') return null;
  const canonicalPath = parseCanonicalStorageObjectPath(filePath, { minimumSegments: 3 });
  if (!canonicalPath || !canonicalPath.startsWith(`retained/${revisionId}/`)) return null;
  return { bucket: RESOURCE_FILES_BUCKET, filePath: canonicalPath };
}

export async function createViewerUnlockFileUrl({
  adminSupabase,
  body,
  countryCode,
  getDetail = getViewerUnlockDetail,
  rateLimitKey,
  unlockId,
  viewerUserId,
}: {
  adminSupabase: ViewerUnlockFileUrlClient;
  body: unknown;
  countryCode: string | null;
  getDetail?: typeof getViewerUnlockDetail;
  rateLimitKey: string;
  unlockId: string;
  viewerUserId: string;
}): Promise<ViewerUnlockFileUrlResult> {
  const requestedPath = parseRequestedPath(body);
  if (!requestedPath) {
    return { ok: false, status: 400, body: { error: 'Missing resource file path.' } };
  }

  const detail = await getDetail({
    adminSupabase,
    unlockId,
    viewerUserId,
    countryCode,
  });
  if (!detail) {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }

  if (!listViewerUnlockStoragePaths(detail).has(requestedPath)) {
    return { ok: false, status: 404, body: { error: 'Resource file not found on this unlock.' } };
  }

  if (!detail.detached && !detail.creatorUserId) {
    return { ok: false, status: 404, body: { error: 'Resource file not found on this unlock.' } };
  }
  const source = resolvePostResourceStorageLocation(
    requestedPath,
    detail.detached ? null : detail.creatorUserId,
  );
  if (!source) {
    return { ok: false, status: 404, body: { error: 'Resource file not found on this unlock.' } };
  }

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
      key: rateLimitKey,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return { ok: false, rateLimitError: error };
    return { ok: false, status: 500, body: { error: 'Failed to check resource file limits.' } };
  }

  let storageLocation = source;

  if (detail.detached) {
    const { data: mapping, error: mappingError } = await adminSupabase
      .from('post_resource_bundle_revision_files')
      .select('retained_bucket, retained_path')
      .eq('revision_id', detail.purchasedRevision.revisionId)
      .eq('source_bucket', source.bucket)
      .eq('source_path', source.filePath)
      .maybeSingle();

    if (mappingError) {
      return { ok: false, status: 500, body: { error: 'Failed to resolve retained resource file.' } };
    }
    if (!mapping) {
      return { ok: false, status: 404, body: { error: 'Retained resource file not found.' } };
    }

    const retainedLocation = resolveRetainedStorageLocation(
      detail.purchasedRevision.revisionId,
      mapping.retained_bucket,
      mapping.retained_path,
    );
    if (!retainedLocation) {
      return { ok: false, status: 404, body: { error: 'Retained resource file not found.' } };
    }
    storageLocation = retainedLocation;
  }

  const { data, error } = await adminSupabase.storage
    .from(storageLocation.bucket)
    .createSignedUrl(storageLocation.filePath, SIGNED_READ_EXPIRES_IN_SECONDS, {
      download: requestedPath.split('/').pop() || 'Resource file',
    });

  if (error || !data?.signedUrl) {
    return { ok: false, status: 500, body: { error: 'Failed to prepare resource file.' } };
  }

  return { ok: true, body: { success: true, signedUrl: data.signedUrl } };
}
