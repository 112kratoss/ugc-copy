import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendRateLimitError,
  WORKFLOW_ASSET_UPLOAD_SIGN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { canUserCreateDurableUpload } from '@/lib/account-deletion-guard';
import { isAllowedStorageBucketMimeType } from '@/lib/storage-upload-mime-policy';
import { releaseUploadBytes, reserveUploadBytes } from '@/lib/upload-byte-admission';

const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;

const WORKFLOW_ASSET_BUCKETS = {
  generated_images: {
    kind: 'image',
    maxBytes: 25 * 1024 * 1024,
  },
  generated_videos: {
    kind: 'video',
    maxBytes: 250 * 1024 * 1024,
  },
  generated_audio: {
    kind: 'audio',
    maxBytes: 50 * 1024 * 1024,
  },
} as const;

const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.dmg',
  '.exe',
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.pkg',
  '.ps1',
  '.scr',
  '.sh',
  '.svg',
]);

export type WorkflowAssetUploadBucket = keyof typeof WORKFLOW_ASSET_BUCKETS;

export type WorkflowAssetUploadSignClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: WorkflowAssetUploadBucket) => {
      createSignedUploadUrl: (
        path: string,
      ) => PromiseLike<{
        data: { token?: string | null; signedUrl?: string | null } | null;
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type WorkflowAssetUploadIntentResult =
  | {
    ok: true;
    response: {
      success: true;
      bucket: WorkflowAssetUploadBucket;
      path: string;
      storagePath: string;
      token: string;
      signedUploadUrl: string | null;
      expiresInSeconds: number;
    };
  }
  | {
    ok: false;
    status: number;
    error: string;
    code?: string;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

type CreateWorkflowAssetUploadIntentInput = {
  body: unknown;
  userId: string;
  client: WorkflowAssetUploadSignClient | (() => WorkflowAssetUploadSignClient);
  createUploadId?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeBucket(value: unknown): WorkflowAssetUploadBucket | null {
  return typeof value === 'string' && value in WORKFLOW_ASSET_BUCKETS
    ? value as WorkflowAssetUploadBucket
    : null;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  const originalExtension = path.extname(baseName);
  const extension = originalExtension.toLowerCase();
  const stem = path.basename(baseName, originalExtension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workflow-input';
  return `${safeStem}${extension || '.bin'}`;
}

function inferExtension(mimeType: string, fileName: string | null): string {
  const extension = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (extension) return extension;
  if (mimeType === 'image/jpeg') return 'jpg';
  const [, subtype] = mimeType.split('/');
  return subtype?.split('+')[0]?.trim() || 'bin';
}

function validateUploadMetadata(body: unknown): {
  bucket: WorkflowAssetUploadBucket;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
} | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid workflow asset upload metadata.' };
  }

  const bucket = normalizeBucket(body.bucket);
  if (!bucket) {
    return { error: 'Choose a valid workflow asset bucket.' };
  }

  const bucketConfig = WORKFLOW_ASSET_BUCKETS[bucket];
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  if (!mimeType || !isAllowedStorageBucketMimeType(bucket, mimeType)) {
    return { error: `Upload a valid ${bucketConfig.kind} file.` };
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'Upload size is required.' };
  }

  if (sizeBytes > bucketConfig.maxBytes) {
    return {
      error: `${bucketConfig.kind[0].toUpperCase()}${bucketConfig.kind.slice(1)} uploads must be ${Math.floor(bucketConfig.maxBytes / 1024 / 1024)}MB or smaller.`,
    };
  }

  const rawFileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName
    : `workflow-input.${inferExtension(mimeType, null)}`;
  const fileName = sanitizeFileName(rawFileName);
  if (BLOCKED_UPLOAD_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    return { error: 'This file type is not supported for workflow uploads.' };
  }

  return {
    bucket,
    fileName,
    mimeType,
    sizeBytes,
  };
}

function resolveClient(client: CreateWorkflowAssetUploadIntentInput['client']) {
  return typeof client === 'function' ? client() : client;
}

export async function createWorkflowAssetUploadIntent({
  body,
  userId,
  client,
  createUploadId = randomUUID,
}: CreateWorkflowAssetUploadIntentInput): Promise<WorkflowAssetUploadIntentResult> {
  const metadata = validateUploadMetadata(body);
  if ('error' in metadata) {
    return {
      ok: false,
      status: 400,
      error: metadata.error,
    };
  }

  const resolvedClient = resolveClient(client);
  const deletionState = await canUserCreateDurableUpload(resolvedClient, userId);
  if (!deletionState.allowed) {
    return deletionState.error
      ? {
          ok: false,
          status: 500,
          error: 'Failed to verify account upload eligibility.',
        }
      : {
          ok: false,
          status: 409,
          code: 'ACCOUNT_DELETION_IN_PROGRESS',
          error: 'Uploads are disabled because this account is being deleted.',
        };
  }

  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...WORKFLOW_ASSET_UPLOAD_SIGN_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        status: error.status,
        code: 'RATE_LIMITED',
        error: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
        limit: error.state.limit,
        remaining: error.state.remaining,
        resetAt: error.state.resetAt,
      };
    }

    return {
      ok: false,
      status: 500,
      error: 'Failed to check workflow upload limits.',
    };
  }

  const uploadPath = `${userId}/workflow-input-${createUploadId()}-${metadata.fileName}`;
  const byteReservation = await reserveUploadBytes(resolvedClient, {
    userId,
    bucket: metadata.bucket,
    storagePath: uploadPath,
    declaredBytes: metadata.sizeBytes,
  });
  if (!byteReservation.ok) {
    return {
      ok: false,
      status: byteReservation.status,
      code: byteReservation.code,
      error: byteReservation.error,
    };
  }
  const { data, error } = await resolvedClient.storage
    .from(metadata.bucket)
    .createSignedUploadUrl(uploadPath);

  if (error || !data?.token) {
    await releaseUploadBytes(resolvedClient, {
      bucket: metadata.bucket,
      storagePath: uploadPath,
    });
    return {
      ok: false,
      status: 500,
      error: 'Failed to prepare workflow asset upload.',
    };
  }

  return {
    ok: true,
    response: {
      success: true,
      bucket: metadata.bucket,
      path: uploadPath,
      storagePath: `${metadata.bucket}/${uploadPath}`,
      token: data.token,
      signedUploadUrl: data.signedUrl ?? null,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
    },
  };
}
