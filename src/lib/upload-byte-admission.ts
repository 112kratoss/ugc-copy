import { randomUUID } from 'node:crypto';

import { logBackendWarning } from '@/lib/backend-logger';

export const UPLOAD_BYTE_ADMISSION_POLICY = {
  perUserBytes: 1024 * 1024 * 1024,
  globalBytes: 100 * 1024 * 1024 * 1024,
  ttlSeconds: 2 * 60 * 60,
} as const;

export type UploadConsumptionDisposition = 'preserve' | 'delete' | 'draft';

export const UPLOAD_CONSUMPTION_LEASE_SECONDS = 30 * 60;

export type UploadConsumptionClaim = {
  uploadId: string;
  userId: string;
  leaseId: string;
  disposition: UploadConsumptionDisposition;
};

export type UploadReservationMutationResult =
  | { ok: true }
  | { ok: false; kind: 'conflict' | 'unavailable'; error: string };

type SupabaseMutationResult = {
  error: unknown;
  status?: unknown;
};

/**
 * Only a received 4xx PostgREST response proves that a database mutation was
 * rejected before commit. A thrown request, status 0, missing status, or 5xx
 * response may have lost its acknowledgement after the transaction committed;
 * upload consumption leases must stay active for quarantine in those cases.
 */
export function isDefinitiveSupabaseMutationRejection(
  result: SupabaseMutationResult,
): boolean {
  return Boolean(
    result.error
    && typeof result.status === 'number'
    && result.status >= 400
    && result.status < 500,
  );
}

export class DefinitiveSupabaseMutationRejection extends Error {
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;
  readonly status: number;

  constructor(error: unknown, status: number) {
    const record = isRecord(error) ? error : null;
    super(typeof record?.message === 'string' ? record.message : String(error));
    this.name = 'DefinitiveSupabaseMutationRejection';
    this.code = typeof record?.code === 'string' ? record.code : undefined;
    this.details = typeof record?.details === 'string' ? record.details : undefined;
    this.hint = typeof record?.hint === 'string' ? record.hint : undefined;
    this.status = status;
  }
}

export function throwSupabaseMutationFailure(result: SupabaseMutationResult): never {
  if (
    isDefinitiveSupabaseMutationRejection(result)
    && typeof result.status === 'number'
  ) {
    throw new DefinitiveSupabaseMutationRejection(result.error, result.status);
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

type ReservationResult =
  | { ok: true; uploadId: string; reservedBytes: number }
  | { ok: false; status: 429 | 500; code: 'UPLOAD_BYTES_LIMIT' | 'UPLOAD_ADMISSION_UNAVAILABLE'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function reserveUploadBytes(
  client: RpcClient,
  params: {
    uploadId: string;
    userId: string;
    bucket: string;
    storagePath: string;
    declaredBytes: number;
    reservedBytes: number;
    expectedContentType: string;
  },
): Promise<ReservationResult> {
  try {
    const { data, error } = await client.rpc('reserve_upload_bytes_v2', {
      p_upload_id: params.uploadId,
      p_user_id: params.userId,
      p_bucket_id: params.bucket,
      p_storage_path: params.storagePath,
      p_declared_bytes: Math.round(params.declaredBytes),
      p_reserved_bytes: Math.round(params.reservedBytes),
      p_expected_content_type: params.expectedContentType.trim().toLowerCase(),
      p_user_limit_bytes: UPLOAD_BYTE_ADMISSION_POLICY.perUserBytes,
      p_global_limit_bytes: UPLOAD_BYTE_ADMISSION_POLICY.globalBytes,
      p_ttl_seconds: UPLOAD_BYTE_ADMISSION_POLICY.ttlSeconds,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (!isRecord(data) || data.allowed !== true) {
      return {
        ok: false,
        status: 429,
        code: 'UPLOAD_BYTES_LIMIT',
        error: 'Too many upload bytes are already reserved. Finish or retry these uploads later.',
      };
    }
    return {
      ok: true,
      // The application supplies the opaque ID so signing and reservation use
      // one value even if an RPC transport omits optional response fields.
      // PostgreSQL rejects identifier/path collisions before returning allowed.
      uploadId: params.uploadId,
      reservedBytes: params.reservedBytes,
    };
  } catch (error) {
    logBackendWarning('upload_byte_admission_unavailable', {
      error: error instanceof Error ? error.message : String(error),
      bucket: params.bucket,
      userId: params.userId,
    });
    return {
      ok: false,
      status: 500,
      code: 'UPLOAD_ADMISSION_UNAVAILABLE',
      error: 'Failed to check upload storage limits.',
    };
  }
}

/**
 * Abort a reservation only while no signed token has been exposed. The
 * database accepts this solely from the pre-issue state; a false result is a
 * conflict and must never be reinterpreted as a successful release.
 */
export async function abortUploadBytesBeforeIssue(
  client: RpcClient,
  params: { uploadId: string; userId: string },
): Promise<UploadReservationMutationResult> {
  try {
    const { data, error } = await client.rpc('abort_upload_byte_reservation_before_issue', {
      p_upload_id: params.uploadId,
      p_user_id: params.userId,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (data !== true) {
      return {
        ok: false,
        kind: 'conflict',
        error: 'The upload reservation was no longer safe to release.',
      };
    }
    return { ok: true };
  } catch (error) {
    logBackendWarning('upload_byte_reservation_abort_before_issue_failed', {
      error: error instanceof Error ? error.message : String(error),
      uploadId: params.uploadId,
      userId: params.userId,
    });
    return {
      ok: false,
      kind: 'unavailable',
      error: 'Failed to cancel the upload reservation.',
    };
  }
}

/** Anchor reclaim eligibility only after Storage has returned a token. */
export async function markUploadBytesIssued(
  client: RpcClient,
  params: {
    uploadId: string;
    userId: string;
    tokenTtlSeconds?: number;
  },
): Promise<UploadReservationMutationResult> {
  try {
    const { data, error } = await client.rpc('mark_upload_byte_reservation_issued', {
      p_upload_id: params.uploadId,
      p_user_id: params.userId,
      p_token_ttl_seconds: params.tokenTtlSeconds ?? UPLOAD_BYTE_ADMISSION_POLICY.ttlSeconds,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (data !== true) {
      return {
        ok: false,
        kind: 'conflict',
        error: 'The signed upload could not be bound to its reservation.',
      };
    }
    return { ok: true };
  } catch (error) {
    logBackendWarning('upload_byte_reservation_issue_mark_failed', {
      error: error instanceof Error ? error.message : String(error),
      uploadId: params.uploadId,
      userId: params.userId,
    });
    return {
      ok: false,
      kind: 'unavailable',
      error: 'Failed to activate the signed upload reservation.',
    };
  }
}

/** Acquire a durable lease before any consumer reads or references the object. */
export async function claimUploadBytesForConsumption(
  client: RpcClient,
  params: {
    uploadId: string;
    userId: string;
    disposition: UploadConsumptionDisposition;
  },
): Promise<
  | { ok: true; claim: UploadConsumptionClaim }
  | { ok: false; kind: 'conflict' | 'unavailable'; error: string }
> {
  const leaseId = randomUUID();
  try {
    const { data, error } = await client.rpc('claim_upload_byte_reservation_consumption', {
      p_upload_id: params.uploadId,
      p_user_id: params.userId,
      p_lease_id: leaseId,
      p_lease_seconds: UPLOAD_CONSUMPTION_LEASE_SECONDS,
      p_disposition: params.disposition,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (data !== true) {
      return {
        ok: false,
        kind: 'conflict',
        error: 'That upload is already being consumed or reclaimed.',
      };
    }
    return {
      ok: true,
      claim: {
        uploadId: params.uploadId,
        userId: params.userId,
        leaseId,
        disposition: params.disposition,
      },
    };
  } catch (error) {
    logBackendWarning('upload_byte_reservation_consumption_claim_failed', {
      error: error instanceof Error ? error.message : String(error),
      uploadId: params.uploadId,
      userId: params.userId,
    });
    return {
      ok: false,
      kind: 'unavailable',
      error: 'Failed to claim the upload for consumption.',
    };
  }
}

/** Complete a lease only after its durable copy/reference has committed. */
export async function completeUploadByteConsumption(
  client: RpcClient,
  params: { claim: UploadConsumptionClaim; disposition: UploadConsumptionDisposition },
): Promise<UploadReservationMutationResult> {
  if (params.disposition !== params.claim.disposition) {
    return {
      ok: false,
      kind: 'conflict',
      error: 'The upload consumption disposition did not match its lease.',
    };
  }
  try {
    const { data, error } = await client.rpc('complete_upload_byte_reservation_consumption', {
      p_upload_id: params.claim.uploadId,
      p_user_id: params.claim.userId,
      p_lease_id: params.claim.leaseId,
      p_disposition: params.disposition,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (data !== true) {
      return {
        ok: false,
        kind: 'conflict',
        error: 'The upload consumption lease was no longer active.',
      };
    }
    return { ok: true };
  } catch (error) {
    logBackendWarning('upload_byte_reservation_consumption_complete_failed', {
      error: error instanceof Error ? error.message : String(error),
      uploadId: params.claim.uploadId,
      userId: params.claim.userId,
    });
    return {
      ok: false,
      kind: 'unavailable',
      error: 'Failed to complete the upload consumption lease.',
    };
  }
}

/** Best-effort unwind; a failed abort remains protected until lease expiry. */
export async function abortUploadByteConsumption(
  client: RpcClient,
  claim: UploadConsumptionClaim,
): Promise<UploadReservationMutationResult> {
  try {
    const { data, error } = await client.rpc('abort_upload_byte_reservation_consumption', {
      p_upload_id: claim.uploadId,
      p_user_id: claim.userId,
      p_lease_id: claim.leaseId,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    if (data !== true) {
      return {
        ok: false,
        kind: 'conflict',
        error: 'The upload consumption lease was no longer active.',
      };
    }
    return { ok: true };
  } catch (error) {
    logBackendWarning('upload_byte_reservation_consumption_abort_failed', {
      error: error instanceof Error ? error.message : String(error),
      uploadId: claim.uploadId,
      userId: claim.userId,
    });
    return {
      ok: false,
      kind: 'unavailable',
      error: 'Failed to abort the upload consumption lease.',
    };
  }
}

/** Compatibility rows have no durable claim; v2 rows must settle theirs. */
export async function completeNullableUploadByteConsumption(
  client: RpcClient,
  params: {
    claim: UploadConsumptionClaim | null;
    disposition: UploadConsumptionDisposition;
  },
): Promise<UploadReservationMutationResult> {
  if (!params.claim) return { ok: true };
  return completeUploadByteConsumption(client, {
    claim: params.claim,
    disposition: params.disposition,
  });
}

export async function abortNullableUploadByteConsumption(
  client: RpcClient,
  claim: UploadConsumptionClaim | null,
): Promise<UploadReservationMutationResult> {
  if (!claim) return { ok: true };
  return abortUploadByteConsumption(client, claim);
}

/** Attempt every post-commit acknowledgement before surfacing any failure. */
export async function completeUploadByteConsumptions(
  client: RpcClient,
  claims: readonly (UploadConsumptionClaim | null)[],
): Promise<UploadReservationMutationResult> {
  const results = await Promise.all(claims.map((claim) => (
    completeNullableUploadByteConsumption(client, {
      claim,
      disposition: claim?.disposition ?? 'preserve',
    })
  )));
  return results.find((result) => !result.ok) ?? { ok: true };
}
