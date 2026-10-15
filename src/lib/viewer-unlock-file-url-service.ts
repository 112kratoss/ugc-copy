import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendError } from '@/lib/backend-logger';
import {
  POST_RESOURCE_FILE_URL_BATCH_LIMIT,
  formatPostResourceDownloadName,
  type PostResourceFileDisposition,
  type PostResourceSignedFileUrl,
} from '@/lib/post-resource-bundles';
import {
  getViewerUnlockDetail,
  listViewerUnlockStoragePaths,
  type ViewerUnlockDetail,
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
const NOT_ON_THIS_UNLOCK = 'Resource file not found on this unlock.';
const RETAINED_FILE_NOT_FOUND = 'Retained resource file not found.';

export type ViewerUnlockFileUrlClient = SupabaseClient & Parameters<typeof enforceBackendRateLimit>[0];

export type ViewerUnlockFileUrlResult =
  | { ok: true; body: { success: true; signedUrl: string } }
  | { ok: true; body: { files: PostResourceSignedFileUrl[] } }
  | { ok: false; status: 400 | 404 | 500; body: { error: string } }
  | { ok: false; rateLimitError: BackendRateLimitError };

type FileUrlRequest =
  | {
    ok: true;
    /** `{ storagePaths }` answers `{ files }`; `{ storagePath }` keeps its `{ success, signedUrl }`. */
    batch: boolean;
    storagePaths: string[];
    disposition: PostResourceFileDisposition;
  }
  | { ok: false; error: string };

type StorageLocation = { bucket: string; filePath: string };

type SignedFileOutcome =
  | { ok: true; file: PostResourceSignedFileUrl }
  | { ok: false; status: 404 | 500; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isExactPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

/** The body the post's own file-url route takes (`post-resource-file-url-service.ts`). */
function parseFileUrlRequest(body: unknown): FileUrlRequest {
  const fields = isRecord(body) ? body : {};
  const disposition = fields.disposition ?? 'attachment';
  if (disposition !== 'inline' && disposition !== 'attachment') {
    return { ok: false, error: 'Unknown file disposition.' };
  }

  if (fields.storagePaths === undefined) {
    return isExactPath(fields.storagePath)
      ? { ok: true, batch: false, storagePaths: [fields.storagePath], disposition }
      : { ok: false, error: 'Missing resource file path.' };
  }

  const storagePaths = fields.storagePaths;
  if (!Array.isArray(storagePaths) || storagePaths.length === 0 || !storagePaths.every(isExactPath)) {
    return { ok: false, error: 'Missing resource file path.' };
  }
  if (storagePaths.length > POST_RESOURCE_FILE_URL_BATCH_LIMIT) {
    return {
      ok: false,
      error: `Ask for at most ${POST_RESOURCE_FILE_URL_BATCH_LIMIT} resource files at a time.`,
    };
  }

  return { ok: true, batch: true, storagePaths: Array.from(new Set(storagePaths)), disposition };
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

/**
 * The name a download saves under, as on the post's own route
 * (`post-resource-file-url-service.ts`): the attachment's label or the item's
 * title with its content type's extension, so one file saves under one name
 * on both routes. The current version is asked before the purchased one.
 */
function resolveDownloadName(detail: ViewerUnlockDetail, storagePath: string): string {
  for (const resources of [detail.currentResources, detail.purchasedRevision.resources]) {
    if (!resources) continue;
    const attachment = resources.attachments.find(
      (item) => item.kind === 'file' && item.storagePath === storagePath,
    ) ?? null;
    const resourceItem = resources.items?.find((item) => item.storagePath === storagePath) ?? null;
    if (attachment || resourceItem) {
      return formatPostResourceDownloadName(
        attachment?.label ?? resourceItem?.title,
        attachment?.contentType ?? resourceItem?.contentType,
      );
    }
  }

  return formatPostResourceDownloadName(null, null);
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

/**
 * One file of an unlock, signed where it is kept: its source while the live
 * bundle exists, its retained copy once the purchase is detached.
 */
async function signUnlockFile({
  adminSupabase,
  detail,
  disposition,
  downloadName,
  expiresAt,
  source,
  storagePath,
}: {
  adminSupabase: ViewerUnlockFileUrlClient;
  detail: ViewerUnlockDetail;
  disposition: PostResourceFileDisposition;
  downloadName: string;
  expiresAt: string;
  source: StorageLocation;
  storagePath: string;
}): Promise<SignedFileOutcome> {
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
      return { ok: false, status: 500, error: 'Failed to resolve retained resource file.' };
    }
    if (!mapping) {
      return { ok: false, status: 404, error: RETAINED_FILE_NOT_FOUND };
    }

    const retainedLocation = resolveRetainedStorageLocation(
      detail.purchasedRevision.revisionId,
      mapping.retained_bucket,
      mapping.retained_path,
    );
    if (!retainedLocation) {
      return { ok: false, status: 404, error: RETAINED_FILE_NOT_FOUND };
    }
    storageLocation = retainedLocation;
  }

  const { data, error } = await adminSupabase.storage
    .from(storageLocation.bucket)
    // Without `download` storage serves the file inline, so "Open" opens it
    // instead of saving it.
    .createSignedUrl(
      storageLocation.filePath,
      SIGNED_READ_EXPIRES_IN_SECONDS,
      disposition === 'attachment' ? { download: downloadName } : {},
    );

  if (error || !data?.signedUrl) {
    return { ok: false, status: 500, error: 'Failed to prepare resource file.' };
  }

  return { ok: true, file: { storagePath, url: data.signedUrl, expiresAt } };
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
  const request = parseFileUrlRequest(body);
  if (!request.ok) {
    return { ok: false, status: 400, body: { error: request.error } };
  }

  // One entitlement load answers the whole request, as on the post's own
  // route: a screen's previews used to sign one file per call, and every call
  // loaded the purchase, its revision and the live bundle again.
  const detail = await getDetail({
    adminSupabase,
    unlockId,
    viewerUserId,
    countryCode,
  });
  if (!detail) {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }

  // A path that is not on this unlock is left out of a batch's answer rather
  // than failing the paths beside it; the caller reads its absence.
  const unlockPaths = listViewerUnlockStoragePaths(detail);
  const ownerUserId = detail.detached ? null : detail.creatorUserId;
  const signableFiles = detail.detached || ownerUserId
    ? request.storagePaths.flatMap((storagePath) => {
      const source = unlockPaths.has(storagePath)
        ? resolvePostResourceStorageLocation(storagePath, ownerUserId)
        : null;
      return source ? [{ storagePath, source, downloadName: resolveDownloadName(detail, storagePath) }] : [];
    })
    : [];
  if (signableFiles.length === 0) {
    return { ok: false, status: 404, body: { error: NOT_ON_THIS_UNLOCK } };
  }

  try {
    // Once per request, so a batch counts as one signing against the limit.
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
      key: rateLimitKey,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return { ok: false, rateLimitError: error };
    return { ok: false, status: 500, body: { error: 'Failed to check resource file limits.' } };
  }

  // Taken before signing, so the stated expiry is never later than the URL's own.
  const expiresAt = new Date(Date.now() + SIGNED_READ_EXPIRES_IN_SECONDS * 1000).toISOString();
  const outcomes = await Promise.all(signableFiles.map(async ({ downloadName, source, storagePath }): Promise<SignedFileOutcome> => {
    try {
      return await signUnlockFile({
        adminSupabase,
        detail,
        disposition: request.disposition,
        downloadName,
        expiresAt,
        source,
        storagePath,
      });
    } catch (error) {
      logBackendError('viewer_unlock_file_sign_failed', { error });
      return { ok: false, status: 500, error: 'Failed to prepare resource file.' };
    }
  }));
  const files = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.file] : []));

  // The single form answers its one file's outcome; a batch answers the files
  // that signed, and the first refusal only when none did.
  if (files.length === 0 || !request.batch) {
    const [first] = outcomes;
    return first.ok
      ? { ok: true, body: { success: true, signedUrl: first.file.url } }
      : { ok: false, status: first.status, body: { error: first.error } };
  }

  return { ok: true, body: { files } };
}
