import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { randomUUID } from 'node:crypto';

import {
  canUserCreateDurableUpload,
  type AccountDeletionGuardClient,
} from '@/lib/account-deletion-guard';
import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { PostResourceAttachment } from '@/lib/post-resource-bundles';
import {
  MAX_POST_RESOURCE_FILE_SIZE_BYTES,
  resolveResourceFileContentType,
  sanitizePostResourceFileName,
} from '@/lib/post-resource-file-upload-service';
import { releaseUploadBytes, reserveUploadBytes } from '@/lib/upload-byte-admission';

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;
const RESOURCE_PATH_PATTERN = /^[0-9a-f-]{36}-[a-z0-9][a-z0-9._-]*$/i;

type ResourceFileMetadata = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

type SignedUploadStorage = {
  createSignedUploadUrl: (
    path: string,
  ) => PromiseLike<{
    data: { token?: string | null; signedUrl?: string | null } | null;
    error: unknown;
  }>;
  info: (
    path: string,
  ) => PromiseLike<{
    data: {
      bucketId?: string | null;
      contentType?: string | null;
      size?: number | null;
    } | null;
    error: unknown;
  }>;
};

export type PostResourceFileDirectUploadClient =
  Parameters<typeof enforceBackendRateLimit>[0]
  & AccountDeletionGuardClient
  & {
    storage: {
      from: (bucket: typeof RESOURCE_FILES_BUCKET) => SignedUploadStorage;
    };
  };

export type PostResourceFileDirectUploadResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 409 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseMetadata(body: unknown): ResourceFileMetadata | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid resource upload metadata.' };
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const requestedContentType = typeof body.contentType === 'string'
    ? body.contentType.trim().toLowerCase()
    : '';
  const sizeBytes = Number(body.sizeBytes);

  if (!fileName || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'File name and upload size are required.' };
  }

  if (sizeBytes > MAX_POST_RESOURCE_FILE_SIZE_BYTES) {
    return { error: 'Resource files must be 50MB or smaller.' };
  }

  const contentType = resolveResourceFileContentType({
    name: fileName,
    type: requestedContentType,
  });
  if (!contentType) {
    return {
      error: 'Upload a safe image, video, audio, workflow, document, or archive resource file.',
    };
  }

  return { fileName, contentType, sizeBytes };
}

function createRateLimitResult(error: BackendRateLimitError): PostResourceFileDirectUploadResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

async function checkUploadAllowed(
  client: PostResourceFileDirectUploadClient,
  userId: string,
): Promise<PostResourceFileDirectUploadResult | null> {
  const deletionState = await canUserCreateDurableUpload(client, userId);
  if (deletionState.allowed) return null;

  if (deletionState.error) {
    logBackendError('post_resource_file_account_deletion_guard_failed', {
      error: deletionState.error,
      userId,
    });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to verify account upload eligibility.' },
    };
  }

  return {
    ok: false,
    status: 409,
    body: {
      error: 'Uploads are disabled because this account is being deleted.',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    },
  };
}

export async function createPostResourceFileUploadIntent({
  body,
  client,
  createUploadId = randomUUID,
  userId,
}: {
  body: unknown;
  client: PostResourceFileDirectUploadClient;
  createUploadId?: () => string;
  userId: string;
}): Promise<PostResourceFileDirectUploadResult> {
  const metadata = parseMetadata(body);
  if ('error' in metadata) {
    return { ok: false, status: 400, body: { error: metadata.error } };
  }

  const uploadDenied = await checkUploadAllowed(client, userId);
  if (uploadDenied) return uploadDenied;

  try {
    await enforceBackendRateLimit(client, {
      ...POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return createRateLimitResult(error);
    logBackendError('post_resource_file_upload_sign_rate_limit_check_failed', { error });
    return { ok: false, status: 500, body: { error: 'Failed to check resource upload limits.' } };
  }

  const safeName = sanitizePostResourceFileName(metadata.fileName);
  const storagePath = `${userId}/${createUploadId()}-${safeName}`;
  const byteReservation = await reserveUploadBytes(client, {
    userId,
    bucket: RESOURCE_FILES_BUCKET,
    storagePath,
    declaredBytes: metadata.sizeBytes,
  });
  if (!byteReservation.ok) {
    return {
      ok: false,
      status: byteReservation.status,
      body: { error: byteReservation.error, code: byteReservation.code },
    };
  }
  const { data, error } = await client.storage
    .from(RESOURCE_FILES_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data?.token) {
    await releaseUploadBytes(client, { bucket: RESOURCE_FILES_BUCKET, storagePath });
    logBackendError('failed_to_create_post_resource_file_upload_url', { error });
    return { ok: false, status: 500, body: { error: 'Failed to prepare resource upload.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      bucket: RESOURCE_FILES_BUCKET,
      path: storagePath,
      token: data.token,
      signedUploadUrl: data.signedUrl ?? null,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
      expected: metadata,
    },
  };
}

export async function finalizePostResourceFileUpload({
  body,
  client,
  userId,
}: {
  body: unknown;
  client: PostResourceFileDirectUploadClient;
  userId: string;
}): Promise<PostResourceFileDirectUploadResult> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, body: { error: 'Invalid resource upload finalizer.' } };
  }

  const metadata = parseMetadata(body);
  if ('error' in metadata) {
    return { ok: false, status: 400, body: { error: metadata.error } };
  }

  const storagePath = typeof body.path === 'string' ? body.path.trim() : '';
  const relativePath = storagePath.startsWith(`${userId}/`)
    ? storagePath.slice(userId.length + 1)
    : '';
  if (!relativePath || !RESOURCE_PATH_PATTERN.test(relativePath)) {
    return { ok: false, status: 400, body: { error: 'Invalid resource upload path.' } };
  }

  const safeName = sanitizePostResourceFileName(metadata.fileName);
  if (!relativePath.endsWith(`-${safeName}`)) {
    return { ok: false, status: 400, body: { error: 'Resource upload metadata does not match its path.' } };
  }

  const { data, error } = await client.storage.from(RESOURCE_FILES_BUCKET).info(storagePath);
  if (error || !data) {
    return { ok: false, status: 400, body: { error: 'Resource upload was not found.' } };
  }

  if (
    data.bucketId && data.bucketId !== RESOURCE_FILES_BUCKET
    || typeof data.size !== 'number'
    || data.size !== metadata.sizeBytes
    || (data.contentType && data.contentType.toLowerCase() !== metadata.contentType)
  ) {
    return { ok: false, status: 400, body: { error: 'Uploaded resource metadata did not match the upload intent.' } };
  }

  const attachment: PostResourceAttachment = {
    label: metadata.fileName,
    kind: 'file',
    storagePath,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
  };

  await releaseUploadBytes(client, { bucket: RESOURCE_FILES_BUCKET, storagePath });

  return {
    ok: true,
    body: {
      success: true,
      attachment,
    },
  };
}
