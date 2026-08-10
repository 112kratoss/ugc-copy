import { logBackendWarning } from '@/lib/backend-logger';

export const UPLOAD_BYTE_ADMISSION_POLICY = {
  perUserBytes: 1024 * 1024 * 1024,
  globalBytes: 100 * 1024 * 1024 * 1024,
  ttlSeconds: 2 * 60 * 60,
} as const;

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

type ReservationResult =
  | { ok: true }
  | { ok: false; status: 429 | 500; code: 'UPLOAD_BYTES_LIMIT' | 'UPLOAD_ADMISSION_UNAVAILABLE'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function reserveUploadBytes(
  client: RpcClient,
  params: { userId: string; bucket: string; storagePath: string; declaredBytes: number },
): Promise<ReservationResult> {
  try {
    const { data, error } = await client.rpc('reserve_upload_bytes', {
      p_user_id: params.userId,
      p_bucket_id: params.bucket,
      p_storage_path: params.storagePath,
      p_declared_bytes: Math.round(params.declaredBytes),
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
    return { ok: true };
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

export async function releaseUploadBytes(
  client: RpcClient,
  params: { bucket: string; storagePath: string },
): Promise<void> {
  try {
    const { error } = await client.rpc('release_upload_byte_reservation', {
      p_bucket_id: params.bucket,
      p_storage_path: params.storagePath,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  } catch (error) {
    logBackendWarning('upload_byte_reservation_release_failed', {
      error: error instanceof Error ? error.message : String(error),
      bucket: params.bucket,
    });
  }
}
