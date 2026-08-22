import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';
import { MEDIA_UPLOAD_INTENTS_TABLE } from '@/lib/media-upload-staging-paths';
import {
  abortUploadBytesBeforeIssue,
  claimUploadBytesForConsumption,
  type UploadConsumptionClaim,
  type UploadConsumptionDisposition,
} from '@/lib/upload-byte-admission';
import {
  USER_SCOPED_STORAGE_BUCKETS,
  parseCanonicalStorageLocation,
} from '@/lib/storage-ownership';

export const UPLOAD_RESERVATIONS_TABLE = 'upload_byte_reservations';

const RESERVATION_SELECT = [
  'id',
  'user_id',
  'bucket_id',
  'storage_path',
  'declared_bytes',
  'reserved_bytes',
  'expected_content_type',
  'actual_bytes',
  'actual_content_type',
  'actual_storage_id',
  'actual_storage_version',
  'finalization_status',
  'issued_at',
  'finalized_at',
  'client_finalized_at',
  'expires_at',
  'released_at',
  'consumed_at',
  'consumption_disposition',
  'consumption_lease_id',
  'consumption_lease_expires_at',
  'consumption_outcome_unknown_at',
  'legacy_compatibility_mode',
  'status_updated_at',
  'reclaim_not_before',
  'reclaim_after',
].join(', ');

export const UPLOAD_RECLAIM_QUIESCENCE_MS = 10 * 60 * 1000;
export const UPLOAD_RECLAIM_TIME_BUDGET_MS = 4 * 60 * 1000;

export type UploadReservationRow = {
  id: string;
  user_id: string;
  bucket_id: string;
  storage_path: string;
  declared_bytes: number;
  reserved_bytes: number;
  expected_content_type: string | null;
  actual_bytes: number | null;
  actual_content_type: string | null;
  actual_storage_id: string | null;
  actual_storage_version: string | null;
  finalization_status:
    | 'reserved'
    | 'issued'
    | 'finalizing'
    | 'finalized'
    | 'consuming'
    | 'consumed'
    | 'reclaiming'
    | 'deleted'
    | 'released';
  finalized_at: string | null;
  issued_at: string | null;
  client_finalized_at: string | null;
  expires_at: string;
  released_at: string | null;
  consumed_at: string | null;
  consumption_disposition: 'preserve' | 'delete' | 'draft' | null;
  consumption_lease_id: string | null;
  consumption_lease_expires_at: string | null;
  consumption_outcome_unknown_at: string | null;
  legacy_compatibility_mode: boolean;
  status_updated_at: string;
  reclaim_not_before: string | null;
  reclaim_after: string | null;
};

export type CanonicalUploadDescriptor = {
  bucket: string;
  path: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
};

export type UploadFinalizationResult =
  | {
      ok: true;
      descriptor: CanonicalUploadDescriptor;
      canonicalPath: string;
      reservationId: string | null;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      code:
        | 'INVALID_UPLOAD_FINALIZER'
        | 'UPLOAD_NOT_FOUND'
        | 'UPLOAD_NOT_READY'
        | 'UPLOAD_METADATA_MISMATCH'
        | 'UPLOAD_FINALIZATION_UNAVAILABLE';
      error: string;
    };

type StorageInfo = {
  id?: unknown;
  version?: unknown;
  bucketId?: unknown;
  contentType?: unknown;
  mimeType?: unknown;
  size?: unknown;
  metadata?: {
    mimetype?: unknown;
    size?: unknown;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeContentType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalized || null;
}

function extractTrustedStorageMetadata(data: unknown): {
  storageId: string | null;
  storageVersion: string | null;
  bucketId: string | null;
  contentType: string | null;
  sizeBytes: number | null;
} {
  const info = isRecord(data) ? data as StorageInfo : null;
  const metadata = info?.metadata && isRecord(info.metadata) ? info.metadata : null;
  const rawSize = info?.size ?? metadata?.size;
  const sizeBytes = typeof rawSize === 'number' && Number.isSafeInteger(rawSize) && rawSize >= 0
    ? rawSize
    : null;
  return {
    storageId: typeof info?.id === 'string' && info.id.trim() ? info.id : null,
    storageVersion: typeof info?.version === 'string' && info.version.trim() ? info.version : null,
    bucketId: typeof info?.bucketId === 'string' ? info.bucketId : null,
    contentType: normalizeContentType(info?.contentType ?? info?.mimeType ?? metadata?.mimetype),
    sizeBytes,
  };
}

function isMissingStorageObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const typed = error as { status?: unknown; statusCode?: unknown };
  return typed.status === 404
    || typed.statusCode === 404
    || typed.statusCode === '404';
}

async function loadReservationById(
  client: SupabaseClient,
  uploadId: string,
  userId: string,
): Promise<{ row: UploadReservationRow | null; error: unknown }> {
  const { data, error } = await client
    .from(UPLOAD_RESERVATIONS_TABLE)
    .select(RESERVATION_SELECT)
    .eq('id', uploadId)
    .eq('user_id', userId)
    .maybeSingle();
  return { row: data as UploadReservationRow | null, error };
}

type ReservationTransitionResult = {
  row: UploadReservationRow | null;
  error: unknown;
};

function nextStatusTimestamp(row: UploadReservationRow, requested = new Date()): string {
  const previous = Date.parse(row.status_updated_at);
  const next = Number.isFinite(previous)
    ? Math.max(requested.getTime(), previous + 1)
    : requested.getTime();
  return new Date(next).toISOString();
}

/** Optimistic lifecycle transition. No stale worker may overwrite a newer state. */
async function transitionReservationState(
  client: SupabaseClient,
  row: UploadReservationRow,
  values: Record<string, unknown>,
  requestedAt = new Date(),
): Promise<ReservationTransitionResult> {
  const { data, error } = await client
    .from(UPLOAD_RESERVATIONS_TABLE)
    .update({ ...values, status_updated_at: nextStatusTimestamp(row, requestedAt) })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
    .eq('finalization_status', row.finalization_status)
    .eq('status_updated_at', row.status_updated_at)
    .is('released_at', null)
    .select(RESERVATION_SELECT)
    .maybeSingle();
  return { row: data as UploadReservationRow | null, error };
}

type TrustedStorageMetadata = ReturnType<typeof extractTrustedStorageMetadata>;

function trustedMetadataMatchesReservation(
  row: UploadReservationRow,
  actual: TrustedStorageMetadata,
  bucket: string,
  options: { requireBoundIdentity: boolean },
): boolean {
  const expectedContentType = normalizeContentType(row.expected_content_type);
  const contentTypeMatches = expectedContentType === 'application/octet-stream'
    ? actual.contentType !== null
    : actual.contentType !== null && actual.contentType === expectedContentType;
  const identityPresent = actual.storageId !== null && actual.storageVersion !== null;
  const boundIdentityMatches = !options.requireBoundIdentity || (
    row.actual_storage_id !== null
    && row.actual_storage_version !== null
    && actual.storageId === row.actual_storage_id
    && actual.storageVersion === row.actual_storage_version
  );

  return identityPresent
    && boundIdentityMatches
    && actual.sizeBytes !== null
    && actual.sizeBytes === row.declared_bytes
    && actual.sizeBytes <= row.reserved_bytes
    && contentTypeMatches
    && (!actual.bucketId || actual.bucketId === bucket);
}

function trustedMetadataCanBeBound(
  row: UploadReservationRow,
  actual: TrustedStorageMetadata,
  bucket: string,
): boolean {
  return actual.storageId !== null
    && actual.storageVersion !== null
    && actual.sizeBytes !== null
    && actual.sizeBytes <= row.reserved_bytes
    && actual.contentType !== null
    && (!actual.bucketId || actual.bucketId === bucket);
}

function hasCompleteTrustedMetadata(actual: TrustedStorageMetadata): boolean {
  return actual.storageId !== null
    && actual.storageVersion !== null
    && actual.contentType !== null
    && actual.sizeBytes !== null;
}

function bindTrustedMetadataIfUnbound(
  row: UploadReservationRow,
  actual: TrustedStorageMetadata,
): Record<string, unknown> {
  if (row.actual_storage_id !== null || row.actual_storage_version !== null) return {};
  return {
    actual_bytes: actual.sizeBytes,
    actual_content_type: actual.contentType,
    actual_storage_id: actual.storageId,
    actual_storage_version: actual.storageVersion,
  };
}

/** Delete one object and require positive evidence that it is gone. */
export async function deleteReservedObjectAndConfirm(
  client: SupabaseClient,
  bucket: string,
  storagePath: string,
): Promise<boolean> {
  const storage = client.storage.from(bucket);
  const removal = await storage.remove([storagePath]);
  if (removal.error) return false;

  const removedNames = new Set(
    ((removal.data ?? []) as Array<{ name?: string }>)
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  if (removedNames.has(storagePath)) return true;

  // Some Storage client versions omit per-object delete results. In that case
  // an authoritative 404 from metadata is the only safe release signal.
  const after = await storage.info(storagePath);
  return Boolean(after.error && isMissingStorageObjectError(after.error));
}

async function finalizeReservationRow(
  client: SupabaseClient,
  row: UploadReservationRow,
  options: { explicitClientFinalization: boolean },
): Promise<UploadFinalizationResult> {
  const location = parseCanonicalStorageLocation(`${row.bucket_id}/${row.storage_path}`, {
    allowedBuckets: USER_SCOPED_STORAGE_BUCKETS,
    ownerUserId: row.user_id,
  });
  if (!location) {
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Upload reservation storage metadata was invalid.',
    };
  }

  if (row.finalization_status === 'deleted') {
    return {
      ok: false,
      status: 400,
      code: 'UPLOAD_NOT_FOUND',
      error: 'That upload is no longer available.',
    };
  }
  if (
    row.finalization_status === 'consumed'
    && (
      row.consumption_disposition === 'preserve'
      || row.consumption_disposition === 'draft'
      || row.consumption_outcome_unknown_at !== null
    )
    && row.actual_storage_id !== null
    && row.actual_storage_version !== null
  ) {
    const info = await client.storage.from(location.bucket).info(location.filePath);
    if (info.error || !info.data) {
      return {
        ok: false,
        status: isMissingStorageObjectError(info.error) ? 404 : 500,
        code: isMissingStorageObjectError(info.error)
          ? 'UPLOAD_NOT_FOUND'
          : 'UPLOAD_FINALIZATION_UNAVAILABLE',
        error: isMissingStorageObjectError(info.error)
          ? 'The consumed upload object was not found.'
          : 'Failed to revalidate the consumed upload.',
      };
    }
    const actual = extractTrustedStorageMetadata(info.data);
    if (!hasCompleteTrustedMetadata(actual)) {
      return {
        ok: false,
        status: 500,
        code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
        error: 'Trusted metadata for the consumed upload was incomplete.',
      };
    }
    if (!trustedMetadataMatchesReservation(row, actual, location.bucket, {
      requireBoundIdentity: true,
    })) {
      const deleted = await deleteReservedObjectAndConfirm(
        client,
        location.bucket,
        location.filePath,
      );
      if (!deleted) {
        return {
          ok: false,
          status: 500,
          code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
          error: 'The replaced consumed upload could not be removed safely.',
        };
      }
      if (!row.released_at) {
        await transitionReservationState(client, row, {
          finalization_status: 'deleted',
        });
      }
      return {
        ok: false,
        status: 409,
        code: 'UPLOAD_METADATA_MISMATCH',
        error: 'The consumed upload no longer matched its trusted object identity.',
      };
    }
    return {
      ok: true,
      // Retained preserve objects are terminal and excluded from reclaim. A
      // draft or unknown-outcome row remains reclaimable, so a retry must take
      // a fresh durable lease before touching it.
      reservationId: !row.released_at && (
        row.consumption_disposition === 'draft'
        || row.consumption_outcome_unknown_at !== null
      )
        ? row.id
        : null,
      canonicalPath: location.filePath,
      descriptor: {
        bucket: location.bucket,
        path: location.filePath,
        storagePath: `${location.bucket}/${location.filePath}`,
        contentType: actual.contentType as string,
        sizeBytes: actual.sizeBytes as number,
      },
    };
  }
  if (row.released_at) {
    return {
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
      error: 'That upload reservation has already been released.',
    };
  }
  if (row.finalization_status === 'consumed') {
    return {
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
      error: 'That upload was already consumed with a non-reusable disposition.',
    };
  }
  if (
    row.finalization_status === 'finalizing'
    || row.finalization_status === 'reclaiming'
    || row.finalization_status === 'released'
  ) {
    return {
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
      error: 'That upload is already being finalized or reclaimed.',
    };
  }
  if (
    row.finalization_status !== 'issued'
    && row.finalization_status !== 'finalized'
  ) {
    return {
      ok: false,
      status: 409,
      code: 'UPLOAD_NOT_READY',
      error: 'That upload cannot be finalized from its current state.',
    };
  }

  const sourceStatus = row.finalization_status;
  const claim = await transitionReservationState(client, row, {
    finalization_status: 'finalizing',
  });
  if (claim.error || !claim.row) {
    return {
      ok: false,
      status: claim.error ? 500 : 409,
      code: claim.error ? 'UPLOAD_FINALIZATION_UNAVAILABLE' : 'UPLOAD_NOT_READY',
      error: claim.error
        ? 'Failed to claim the upload for finalization.'
        : 'That upload could not be claimed for finalization.',
    };
  }

  const claimed = claim.row;
  const info = await client.storage.from(location.bucket).info(location.filePath);
  if (info.error || !info.data) {
    if (isMissingStorageObjectError(info.error)) {
      const invalidated = await transitionReservationState(client, claimed, {
        finalization_status: 'deleted',
      });
      if (invalidated.error || !invalidated.row) {
        return {
          ok: false,
          status: invalidated.error ? 500 : 409,
          code: invalidated.error ? 'UPLOAD_FINALIZATION_UNAVAILABLE' : 'UPLOAD_NOT_READY',
          error: 'The missing upload could not be invalidated safely.',
        };
      }
      return {
        ok: false,
        status: 400,
        code: 'UPLOAD_NOT_FOUND',
        error: 'The uploaded object was not found.',
      };
    }

    await transitionReservationState(client, claimed, { finalization_status: sourceStatus });
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Failed to verify the uploaded object.',
    };
  }

  const actual = extractTrustedStorageMetadata(info.data);
  if (!hasCompleteTrustedMetadata(actual)) {
    await transitionReservationState(client, claimed, { finalization_status: sourceStatus });
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Trusted upload metadata was incomplete.',
    };
  }
  const metadataMatches = trustedMetadataMatchesReservation(claimed, actual, location.bucket, {
    requireBoundIdentity: sourceStatus === 'finalized',
  });

  if (!metadataMatches) {
    const deleted = await deleteReservedObjectAndConfirm(client, location.bucket, location.filePath);
    if (!deleted) {
      await transitionReservationState(client, claimed, { finalization_status: sourceStatus });
      return {
        ok: false,
        status: 500,
        code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
        error: 'The invalid upload could not be removed safely.',
      };
    }

    const invalidated = await transitionReservationState(client, claimed, {
      // Once identity is bound, the original trusted metadata is immutable.
      // A replacement object is evidence of replay, not a new version to bind.
      ...(sourceStatus === 'issued'
        ? {
            actual_bytes: actual.sizeBytes,
            actual_content_type: actual.contentType,
            actual_storage_id: actual.storageId,
            actual_storage_version: actual.storageVersion,
          }
        : {}),
      finalization_status: 'deleted',
    });
    if (invalidated.error || !invalidated.row) {
      return {
        ok: false,
        status: invalidated.error ? 500 : 409,
        code: invalidated.error ? 'UPLOAD_FINALIZATION_UNAVAILABLE' : 'UPLOAD_NOT_READY',
        error: 'The invalid upload was removed but its reservation changed concurrently.',
      };
    }
    return {
      ok: false,
      status: 400,
      code: 'UPLOAD_METADATA_MISMATCH',
      error: 'Uploaded object metadata did not match the server-issued upload intent.',
    };
  }

  const finalizedAt = claimed.finalized_at ?? new Date().toISOString();
  const update = await transitionReservationState(client, claimed, {
    actual_bytes: actual.sizeBytes,
    actual_content_type: actual.contentType,
    actual_storage_id: actual.storageId,
    actual_storage_version: actual.storageVersion,
    finalization_status: 'finalized',
    finalized_at: finalizedAt,
    ...(options.explicitClientFinalization
      ? { client_finalized_at: claimed.client_finalized_at ?? finalizedAt }
      : {}),
  });
  if (update.error || !update.row) {
    logBackendWarning('upload_finalization_state_update_failed', {
      error: update.error,
      uploadId: claimed.id,
    });
    return {
      ok: false,
      status: update.error ? 500 : 409,
      code: update.error ? 'UPLOAD_FINALIZATION_UNAVAILABLE' : 'UPLOAD_NOT_READY',
      error: update.error
        ? 'Failed to record upload finalization.'
        : 'The upload changed while finalization was being recorded.',
    };
  }

  return {
    ok: true,
    reservationId: update.row.id,
    canonicalPath: location.filePath,
    descriptor: {
      bucket: location.bucket,
      path: location.filePath,
      storagePath: `${location.bucket}/${location.filePath}`,
      contentType: actual.contentType as string,
      sizeBytes: actual.sizeBytes as number,
    },
  };
}

export async function finalizeUploadById(
  client: SupabaseClient,
  params: { uploadId: string; userId: string },
): Promise<UploadFinalizationResult> {
  const loaded = await loadReservationById(client, params.uploadId, params.userId);
  if (loaded.error) {
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Failed to load the upload intent.',
    };
  }
  if (!loaded.row) {
    return {
      ok: false,
      status: 404,
      code: 'UPLOAD_NOT_FOUND',
      error: 'Upload intent not found.',
    };
  }
  return finalizeReservationRow(client, loaded.row, { explicitClientFinalization: true });
}

export async function finalizeUploadRequest(
  client: SupabaseClient,
  params: { body: unknown; userId: string },
): Promise<UploadFinalizationResult> {
  if (
    !isRecord(params.body)
    || Object.keys(params.body).some((key) => key !== 'uploadId')
    || typeof params.body.uploadId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.body.uploadId)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_UPLOAD_FINALIZER',
      error: 'A valid uploadId is required.',
    };
  }
  return finalizeUploadById(client, {
    uploadId: params.body.uploadId,
    userId: params.userId,
  });
}

/**
 * Compatibility path for clients that submit the signed storage path directly.
 * A reservation created by the new sign endpoints is finalized before its
 * bytes are consumed. Objects issued before the additive migration have no row
 * and remain subject to the consumer's existing validation during the mobile
 * compatibility window.
 */
export async function finalizeUploadAtPath(
  client: SupabaseClient,
  params: {
    bucket: string;
    storagePath: string;
    userId: string;
    explicitClientFinalization?: boolean;
  },
): Promise<
  | Extract<UploadFinalizationResult, { ok: true }>
  | { ok: true; descriptor: null; canonicalPath: string; reservationId: null }
  | Extract<UploadFinalizationResult, { ok: false }>
> {
  const location = parseCanonicalStorageLocation(`${params.bucket}/${params.storagePath}`, {
    allowedBuckets: USER_SCOPED_STORAGE_BUCKETS,
    ownerUserId: params.userId,
  });
  if (!location || location.bucket !== params.bucket) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_UPLOAD_FINALIZER',
      error: 'Upload storage path was invalid.',
    };
  }

  const { data, error } = await client
    .from(UPLOAD_RESERVATIONS_TABLE)
    .select(RESERVATION_SELECT)
    .eq('user_id', params.userId)
    .eq('bucket_id', location.bucket)
    .eq('storage_path', location.filePath)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Failed to load the upload intent.',
    };
  }
  if (!data) {
    return {
      ok: true,
      descriptor: null,
      canonicalPath: location.filePath,
      reservationId: null,
    };
  }
  return finalizeReservationRow(client, data as unknown as UploadReservationRow, {
    explicitClientFinalization: params.explicitClientFinalization === true,
  });
}

/**
 * Finalize trusted metadata and acquire a database lease before the caller
 * reads, copies, or durably references the object. The reclaimer cannot claim
 * the row until this lease is completed, aborted, or expires.
 */
export async function finalizeUploadForConsumption(
  client: SupabaseClient,
  params: {
    bucket: string;
    storagePath: string;
    userId: string;
    disposition: UploadConsumptionDisposition;
  },
): Promise<
  | {
      ok: true;
      descriptor: CanonicalUploadDescriptor;
      canonicalPath: string;
      reservationId: string;
      consumptionClaim: UploadConsumptionClaim;
    }
  | {
      ok: true;
      descriptor: CanonicalUploadDescriptor | null;
      canonicalPath: string;
      reservationId: null;
      consumptionClaim: null;
    }
  | Extract<UploadFinalizationResult, { ok: false }>
> {
  const finalized = await finalizeUploadAtPath(client, params);
  if (!finalized.ok) return finalized;

  // Compatibility rows created before uploadId finalization cannot be leased.
  // Their existing consumer checks remain in force only during the additive
  // mobile rollout window.
  if (finalized.reservationId === null) {
    return {
      ok: true,
      descriptor: finalized.descriptor,
      canonicalPath: finalized.canonicalPath,
      reservationId: null,
      consumptionClaim: null,
    };
  }
  if (!finalized.descriptor) {
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: 'Finalized upload metadata was unavailable.',
    };
  }

  const claimed = await claimUploadBytesForConsumption(client, {
    uploadId: finalized.reservationId,
    userId: params.userId,
    disposition: params.disposition,
  });
  if (!claimed.ok) {
    return {
      ok: false,
      status: claimed.kind === 'conflict' ? 409 : 500,
      code: claimed.kind === 'conflict'
        ? 'UPLOAD_NOT_READY'
        : 'UPLOAD_FINALIZATION_UNAVAILABLE',
      error: claimed.error,
    };
  }
  return {
    ok: true,
    descriptor: finalized.descriptor,
    canonicalPath: finalized.canonicalPath,
    reservationId: finalized.reservationId,
    consumptionClaim: claimed.claim,
  };
}

export type ExpiredUploadReservationReclaimSummary = {
  scanned: number;
  handled: number;
  objectsDeleted: number;
  absentObjectsReleased: number;
  failed: number;
  bytesDeleted: number;
  scanLimitReached: boolean;
  timeBudgetReached: boolean;
  oldestCandidateExpiresAt: string | null;
};

type UploadIntentStateRow = {
  user_id: string;
  storage_path: string;
  storage_cleared_at: string | null;
};

function reservationStorageKey(userId: string, storagePath: string): string {
  return `${userId}\u0000${storagePath}`;
}

/**
 * The reservation worker must not race the longer-lived mobile draft policy.
 * Uncleared `uploads` objects belong to the media-intent sweep, which owns the
 * rollout gate, 48-hour window, and protected-generation checks. While that
 * gate is disabled, a missing intent is also protected for rolling clients.
 */
async function loadProtectedMobileUploadKeys(
  client: SupabaseClient,
  rows: UploadReservationRow[],
  now: Date,
): Promise<{ keys: Set<string>; failed: boolean }> {
  const uploads = rows.filter((row) => row.bucket_id === 'uploads');
  if (uploads.length === 0) return { keys: new Set(), failed: false };

  const paths = [...new Set(uploads.map((row) => row.storage_path))];
  const { data, error } = await client
    .from(MEDIA_UPLOAD_INTENTS_TABLE)
    .select('user_id, storage_path, storage_cleared_at')
    .in('storage_path', paths);
  if (error) {
    return {
      keys: new Set(uploads.map((row) => reservationStorageKey(row.user_id, row.storage_path))),
      failed: true,
    };
  }

  const keys = new Set<string>();
  const knownKeys = new Set<string>();
  const reservationsByKey = new Map(uploads.map((row) => [
    reservationStorageKey(row.user_id, row.storage_path),
    row,
  ]));
  const explicitAbandonCutoff = now.getTime() - RECLAIM_AFTER_HOURS * 60 * 60 * 1000;
  const mayReclaimExplicitAbandon = (row: UploadReservationRow) => {
    const explicitlyFinalizedAt = row.client_finalized_at
      ? Date.parse(row.client_finalized_at)
      : Number.NaN;
    return row.consumed_at === null
      && Number.isFinite(explicitlyFinalizedAt)
      && explicitlyFinalizedAt <= explicitAbandonCutoff;
  };
  for (const intent of (data ?? []) as UploadIntentStateRow[]) {
    const canonicalPath = parseCanonicalStorageLocation(`uploads/${intent.storage_path}`, {
      allowedBuckets: ['uploads'],
      ownerUserId: intent.user_id,
    });
    if (canonicalPath) {
      const key = reservationStorageKey(intent.user_id, canonicalPath.filePath);
      knownKeys.add(key);
      const reservation = reservationsByKey.get(key);
      const deletionRequested = reservation?.finalization_status === 'deleted'
        || reservation?.consumption_disposition === 'delete';
      if (
        !intent.storage_cleared_at
        && !deletionRequested
        && (!reservation || !mayReclaimExplicitAbandon(reservation))
      ) {
        keys.add(key);
      }
    }
  }

  if (!getMediaUploadReclaimPolicy().effectiveEnabled) {
    for (const row of uploads) {
      const key = reservationStorageKey(row.user_id, row.storage_path);
      // A missing legacy intent is ambiguous during the compatibility window,
      // so fail closed until the minimum supported app version advances.
      if (
        !knownKeys.has(key)
        && row.finalization_status !== 'deleted'
        && row.consumption_disposition !== 'delete'
        && !mayReclaimExplicitAbandon(row)
      ) keys.add(key);
    }
  }
  return { keys, failed: false };
}

async function deferReservationReclaim(
  client: SupabaseClient,
  row: UploadReservationRow,
  reclaimAfter: Date,
  now: Date,
): Promise<boolean> {
  const current = row.reclaim_after ? Date.parse(row.reclaim_after) : Number.NaN;
  if (Number.isFinite(current) && current > now.getTime()) return true;
  const update = await transitionReservationState(client, row, {
    reclaim_after: reclaimAfter.toISOString(),
  }, now);
  return !update.error && Boolean(update.row);
}

/**
 * Reclaim expired URLs without treating expiry as proof that their objects are
 * gone. Each row stays charged until Storage confirms deletion or an
 * authoritative metadata lookup proves the object never existed.
 */
export async function reclaimExpiredUploadReservations(
  client: SupabaseClient,
  options: {
    now?: Date;
    limit?: number;
    scanLimit?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<ExpiredUploadReservationReclaimSummary> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const scanLimit = Math.max(
    limit,
    Math.min(options.scanLimit ?? Math.max(500, limit * 4), 20_000),
  );
  const timeBudgetMs = Math.max(
    1_000,
    Math.min(options.timeBudgetMs ?? UPLOAD_RECLAIM_TIME_BUDGET_MS, 290_000),
  );
  const deadline = performance.now() + timeBudgetMs;
  const timeExpired = () => performance.now() >= deadline;
  const staleClaimBefore = new Date(now.getTime() - UPLOAD_RECLAIM_QUIESCENCE_MS).toISOString();
  const summary: ExpiredUploadReservationReclaimSummary = {
    scanned: 0,
    handled: 0,
    objectsDeleted: 0,
    absentObjectsReleased: 0,
    failed: 0,
    bytesDeleted: 0,
    scanLimitReached: false,
    timeBudgetReached: false,
    oldestCandidateExpiresAt: null,
  };
  const pageSize = Math.min(scanLimit, 500);
  const explicitAbandonCutoff = now.getTime() - RECLAIM_AFTER_HOURS * 60 * 60 * 1000;
  let handled = 0;
  let cursor: { expiresAt: string; id: string } | null = null;

  // Three independent ceilings matter: rows read, state/storage actions, and
  // wall-clock. A protected-row population can no longer turn an action limit
  // into an unbounded scan or consume the full 300-second scheduler window.
  while (handled < limit && summary.scanned < scanLimit) {
    if (timeExpired()) {
      summary.timeBudgetReached = true;
      break;
    }
    let query = client
      .from(UPLOAD_RESERVATIONS_TABLE)
      .select(RESERVATION_SELECT)
      .is('released_at', null)
      .in('finalization_status', [
        'reserved',
        'issued',
        'finalizing',
        'finalized',
        'consuming',
        'consumed',
        'deleted',
        'reclaiming',
      ])
      .lte('expires_at', now.toISOString())
      .or(`reclaim_after.is.null,reclaim_after.lte.${now.toISOString()}`)
      .order('expires_at', { ascending: true })
      .order('id', { ascending: true });
    if (cursor) {
      query = query.or(
        `expires_at.gt.${cursor.expiresAt},and(expires_at.eq.${cursor.expiresAt},id.gt.${cursor.id})`,
      );
    }
    const { data, error } = await query.limit(Math.min(pageSize, scanLimit - summary.scanned));
    if (error) throw error;
    const rows = (data ?? []) as unknown as UploadReservationRow[];
    if (rows.length === 0) break;
    summary.scanned += rows.length;
    summary.oldestCandidateExpiresAt ??= rows[0]?.expires_at ?? null;
    const lastRow = rows[rows.length - 1];
    if (lastRow) cursor = { expiresAt: lastRow.expires_at, id: lastRow.id };

    const protectedUploads = await loadProtectedMobileUploadKeys(client, rows, now);
    if (protectedUploads.failed) {
      logBackendWarning('upload_reservation_reclaim_mobile_intent_lookup_failed', {
        uploads: rows.filter((row) => row.bucket_id === 'uploads').length,
      });
    }

    for (const row of rows) {
      if (handled >= limit) break;
      if (timeExpired()) {
        summary.timeBudgetReached = true;
        break;
      }
      const location = parseCanonicalStorageLocation(`${row.bucket_id}/${row.storage_path}`, {
        allowedBuckets: USER_SCOPED_STORAGE_BUCKETS,
        ownerUserId: row.user_id,
      });
      if (!location) {
        summary.failed += 1;
        handled += 1;
        continue;
      }

      const explicitlyFinalizedAt = row.client_finalized_at
        ? Date.parse(row.client_finalized_at)
        : Number.NaN;
      if (
        row.consumed_at === null
        && Number.isFinite(explicitlyFinalizedAt)
        && explicitlyFinalizedAt > explicitAbandonCutoff
      ) {
        // Explicitly finalized drafts get the same compatibility window as
        // staged mobile uploads; after it lapses they are ordinary abandonment.
        const deferred = await deferReservationReclaim(
          client,
          row,
          new Date(explicitlyFinalizedAt + RECLAIM_AFTER_HOURS * 60 * 60 * 1000),
          now,
        );
        handled += 1;
        if (!deferred) summary.failed += 1;
        continue;
      }

      const mobileProtected = protectedUploads.keys.has(
        reservationStorageKey(row.user_id, location.filePath),
      );
      const legacyPersistent = row.legacy_compatibility_mode
        && (
          row.bucket_id === 'profiles'
          || row.bucket_id === 'generated_images'
          || row.bucket_id === 'generated_videos'
          || row.bucket_id === 'generated_audio'
          || row.bucket_id === 'post_resource_files'
        )
        && row.finalization_status !== 'deleted';
      const intendedPreservation = row.consumption_disposition === 'preserve'
        ? 'preserve'
        : row.consumption_disposition === 'draft'
          ? mobileProtected ? 'draft' : null
        : mobileProtected
          ? 'draft'
          : legacyPersistent
            ? 'preserve'
            : null;

      const leaseExpiresAt = row.consumption_lease_expires_at
        ? Date.parse(row.consumption_lease_expires_at)
        : Number.NaN;
      if (row.finalization_status === 'consuming') {
        if (!Number.isFinite(leaseExpiresAt)) {
          summary.failed += 1;
          handled += 1;
          continue;
        }
        if (leaseExpiresAt > now.getTime()) {
          const deferred = await deferReservationReclaim(
            client,
            row,
            new Date(leaseExpiresAt),
            now,
          );
          handled += 1;
          if (!deferred) summary.failed += 1;
          continue;
        }

        // A timed-out completion acknowledgement has an unknown outcome: the
        // caller's durable mutation may have committed before the response was
        // lost. Never delete a still-present object from this state, even when
        // the requested disposition was `delete`. Exact trusted metadata stays
        // retained and charged at actual bytes for manual/retry reconciliation.
        const info = await client.storage.from(location.bucket).info(location.filePath);
        if (info.error || !info.data) {
          if (!isMissingStorageObjectError(info.error)) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
        } else {
          const actual = extractTrustedStorageMetadata(info.data);
          if (!hasCompleteTrustedMetadata(actual)) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
          if (trustedMetadataMatchesReservation(row, actual, location.bucket, {
            requireBoundIdentity: true,
          })) {
            const quarantined = await transitionReservationState(client, row, {
              finalization_status: 'consumed',
              consumed_at: row.consumed_at ?? now.toISOString(),
              consumption_outcome_unknown_at:
                row.consumption_outcome_unknown_at ?? now.toISOString(),
              consumption_lease_id: null,
              consumption_lease_expires_at: null,
            }, now);
            handled += 1;
            if (quarantined.error || !quarantined.row) summary.failed += 1;
            continue;
          }
          const deletedReplacement = await deleteReservedObjectAndConfirm(
            client,
            location.bucket,
            location.filePath,
          );
          if (!deletedReplacement) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
        }

        // Only proven absence (or a confirmed deletion of an identity-mismatched
        // replacement) may leave the unknown-outcome state. It still takes the
        // ordinary second pass before capacity is released.
        const reclaimNotBefore = new Date(Math.max(
          now.getTime() + UPLOAD_RECLAIM_QUIESCENCE_MS,
          Date.parse(row.expires_at) + UPLOAD_RECLAIM_QUIESCENCE_MS,
        )).toISOString();
        const absentClaim = await transitionReservationState(client, row, {
          finalization_status: 'reclaiming',
          ...(row.reclaim_not_before ? {} : { reclaim_not_before: reclaimNotBefore }),
          consumption_lease_id: null,
          consumption_lease_expires_at: null,
        }, now);
        handled += 1;
        if (absentClaim.error || !absentClaim.row) summary.failed += 1;
        continue;
      }

      if (
        row.finalization_status === 'consumed'
        && row.consumption_outcome_unknown_at !== null
      ) {
        // This terminal quarantine is retryable through the normal consumer:
        // exact revalidation returns the reservation id and the claim RPC may
        // create a fresh lease with the same immutable disposition. Until that
        // completion succeeds, only proven absence can enter reclaim.
        const info = await client.storage.from(location.bucket).info(location.filePath);
        let objectAbsent = false;
        if (info.error || !info.data) {
          if (!isMissingStorageObjectError(info.error)) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
          objectAbsent = true;
        } else {
          const actual = extractTrustedStorageMetadata(info.data);
          if (!hasCompleteTrustedMetadata(actual)) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
          if (trustedMetadataMatchesReservation(row, actual, location.bucket, {
            requireBoundIdentity: true,
          })) {
            handled += 1;
            continue;
          }
          objectAbsent = await deleteReservedObjectAndConfirm(
            client,
            location.bucket,
            location.filePath,
          );
          if (!objectAbsent) {
            summary.failed += 1;
            handled += 1;
            continue;
          }
        }

        if (objectAbsent) {
          const expiresAt = Date.parse(row.expires_at);
          const reclaimNotBefore = new Date(Math.max(
            now.getTime() + UPLOAD_RECLAIM_QUIESCENCE_MS,
            (Number.isFinite(expiresAt) ? expiresAt : now.getTime())
              + UPLOAD_RECLAIM_QUIESCENCE_MS,
          )).toISOString();
          const absentClaim = await transitionReservationState(client, row, {
            finalization_status: 'reclaiming',
            // A quarantined consumed row starts a fresh two-observation gate;
            // the database permits this exact consumed -> reclaiming refresh.
            reclaim_not_before: reclaimNotBefore,
          }, now);
          handled += 1;
          if (absentClaim.error || !absentClaim.row) summary.failed += 1;
        }
        continue;
      }

      // A reconciled draft intentionally remains stored and charged at trusted
      // actual bytes until the media-intent sweep is allowed to remove it.
      if (
        mobileProtected
        &&
        row.finalization_status === 'consumed'
        && row.consumption_disposition === 'draft'
        && row.actual_storage_id !== null
        && row.actual_storage_version !== null
        && row.reclaim_not_before !== null
      ) {
        const deferred = await deferReservationReclaim(
          client,
          row,
          new Date(now.getTime() + 24 * 60 * 60 * 1000),
          now,
        );
        handled += 1;
        if (!deferred) summary.failed += 1;
        continue;
      }
      if (
        legacyPersistent
        && row.finalization_status === 'consumed'
        && row.consumption_disposition === 'preserve'
        && row.actual_storage_id !== null
        && row.actual_storage_version !== null
        && row.reclaim_not_before !== null
      ) {
        // Legacy durable surfaces cannot distinguish an abandoned upload from
        // one referenced by a rolling old server. Retain the exact object but
        // keep charging its trusted actual bytes until reference reconciliation
        // or the compatibility contraction can classify it safely.
        const deferred = await deferReservationReclaim(
          client,
          row,
          new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          now,
        );
        handled += 1;
        if (!deferred) summary.failed += 1;
        continue;
      }

      if (row.finalization_status === 'reserved') {
        const aborted = await abortUploadBytesBeforeIssue(client, {
          uploadId: row.id,
          userId: row.user_id,
        });
        handled += 1;
        if (aborted.ok) summary.absentObjectsReleased += 1;
        else summary.failed += 1;
        continue;
      }

      const statusUpdatedAt = Date.parse(row.status_updated_at);
      const reclaimNotBefore = row.reclaim_not_before
        ? Date.parse(row.reclaim_not_before)
        : Number.NaN;
      const secondPassReady = row.finalization_status === 'reclaiming'
        && Number.isFinite(reclaimNotBefore)
        && reclaimNotBefore <= now.getTime()
        && Number.isFinite(statusUpdatedAt)
        && statusUpdatedAt <= Date.parse(staleClaimBefore);

      if (!secondPassReady) {
        if (
          row.finalization_status === 'finalizing'
          && (!Number.isFinite(statusUpdatedAt) || statusUpdatedAt > Date.parse(staleClaimBefore))
        ) {
          const deferred = await deferReservationReclaim(
            client,
            row,
            new Date(Math.max(now.getTime() + 1_000, statusUpdatedAt + UPLOAD_RECLAIM_QUIESCENCE_MS)),
            now,
          );
          handled += 1;
          if (!deferred) summary.failed += 1;
          continue;
        }
        if (row.finalization_status === 'reclaiming' && row.reclaim_not_before) {
          const deferred = await deferReservationReclaim(
            client,
            row,
            new Date(row.reclaim_not_before),
            now,
          );
          handled += 1;
          if (!deferred) summary.failed += 1;
          continue;
        }

        const expiresAt = Date.parse(row.expires_at);
        const notBefore = new Date(Math.max(
          now.getTime() + UPLOAD_RECLAIM_QUIESCENCE_MS,
          (Number.isFinite(expiresAt) ? expiresAt : now.getTime()) + UPLOAD_RECLAIM_QUIESCENCE_MS,
        )).toISOString();
        const firstClaim = await transitionReservationState(client, row, {
          finalization_status: 'reclaiming',
          // A consumed object re-entering reclaim needs a fresh database-
          // enforced observation interval. Other lifecycle states retain an
          // existing capability gate, which remains immutable.
          ...(row.finalization_status === 'consumed' || !row.reclaim_not_before
            ? { reclaim_not_before: notBefore }
            : {}),
        }, now);
        handled += 1;
        if (firstClaim.error || !firstClaim.row) summary.failed += 1;
        continue;
      }

      const claim = await transitionReservationState(client, row, {
        finalization_status: 'reclaiming',
      }, now);
      handled += 1;
      if (claim.error || !claim.row) {
        summary.failed += 1;
        continue;
      }
      const claimed = claim.row;

      const info = await client.storage.from(location.bucket).info(location.filePath);
      if (info.error || !info.data) {
        if (isMissingStorageObjectError(info.error)) {
          const update = await transitionReservationState(client, claimed, {
            finalization_status: 'deleted',
            released_at: now.toISOString(),
          }, now);
          if (update.error || !update.row) summary.failed += 1;
          else summary.absentObjectsReleased += 1;
        } else {
          summary.failed += 1;
        }
        continue;
      }

      const actual = extractTrustedStorageMetadata(info.data);
      const identityAlreadyBound = claimed.actual_storage_id !== null
        && claimed.actual_storage_version !== null;
      const boundObjectMatches = identityAlreadyBound
        && trustedMetadataMatchesReservation(claimed, actual, location.bucket, {
          requireBoundIdentity: true,
        });
      const unboundObjectCanBePreserved = !identityAlreadyBound && (
        legacyPersistent
          ? trustedMetadataCanBeBound(claimed, actual, location.bucket)
          : trustedMetadataMatchesReservation(claimed, actual, location.bucket, {
              requireBoundIdentity: false,
            })
      );

      if (intendedPreservation && (boundObjectMatches || unboundObjectCanBePreserved)) {
        const preserveDurably = intendedPreservation === 'preserve' && !legacyPersistent;
        const update = await transitionReservationState(client, claimed, {
          ...bindTrustedMetadataIfUnbound(claimed, actual),
          finalization_status: 'consumed',
          finalized_at: claimed.finalized_at ?? now.toISOString(),
          consumed_at: claimed.consumed_at ?? now.toISOString(),
          consumption_disposition: claimed.consumption_disposition ?? intendedPreservation,
          ...(preserveDurably ? { released_at: now.toISOString() } : {}),
        }, now);
        if (update.error || !update.row) summary.failed += 1;
        continue;
      }

      const deleted = await deleteReservedObjectAndConfirm(client, location.bucket, location.filePath);
      if (!deleted) {
        summary.failed += 1;
        continue;
      }

      const update = await transitionReservationState(client, claimed, {
        ...bindTrustedMetadataIfUnbound(claimed, actual),
        finalization_status: 'deleted',
        released_at: now.toISOString(),
      }, now);
      if (update.error || !update.row) {
        summary.failed += 1;
        continue;
      }
      summary.objectsDeleted += 1;
      summary.bytesDeleted += actual.sizeBytes ?? 0;
    }

    if (rows.length < pageSize) break;
  }
  summary.handled = handled;
  summary.scanLimitReached = summary.scanned >= scanLimit;
  return summary;
}
