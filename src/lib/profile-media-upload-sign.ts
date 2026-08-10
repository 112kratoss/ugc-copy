import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendRateLimitError,
  PROFILE_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { canUserCreateDurableUpload } from '@/lib/account-deletion-guard';
import { isAllowedStorageBucketMimeType } from '@/lib/storage-upload-mime-policy';
import { releaseUploadBytes, reserveUploadBytes } from '@/lib/upload-byte-admission';

const PROFILE_MEDIA_BUCKET = 'profiles';
const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const BLOCKED_PROFILE_IMAGE_EXTENSIONS = new Set(['.svg', '.html', '.htm', '.js', '.mjs']);

type ProfileMediaRole = 'avatar' | 'cover';

export type ProfileMediaUploadSignClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: typeof PROFILE_MEDIA_BUCKET) => {
      createSignedUploadUrl: (
        path: string,
      ) => PromiseLike<{
        data: { token?: string | null; signedUrl?: string | null } | null;
        error: { message?: string } | Error | null;
      }>;
      getPublicUrl: (
        path: string,
      ) => {
        data: { publicUrl?: string | null };
      };
    };
  };
};

export type ProfileMediaUploadIntentResult =
  | {
      ok: true;
      body: {
        success: true;
        bucket: typeof PROFILE_MEDIA_BUCKET;
        path: string;
        token: string;
        signedUploadUrl: string | null;
        publicUrl: string;
        expiresInSeconds: number;
      };
    }
  | {
      ok: false;
      status: 400 | 409 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreateProfileMediaUploadIntentInput = {
  body: unknown;
  userId: string;
  client: ProfileMediaUploadSignClient | (() => ProfileMediaUploadSignClient);
  createUploadId?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  const originalExtension = path.extname(baseName);
  const extension = originalExtension.toLowerCase();
  const stem = path.basename(baseName, originalExtension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'profile';
  return `${safeStem}${extension || '.jpg'}`;
}

function normalizeRole(value: unknown): ProfileMediaRole | null {
  return value === 'avatar' || value === 'cover' ? value : null;
}

function inferImageExtension(mimeType: string, fileName: string | null): string {
  const extension = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (extension) return extension;
  if (mimeType === 'image/jpeg') return 'jpg';
  const [, subtype] = mimeType.split('/');
  return subtype?.split('+')[0]?.trim() || 'jpg';
}

function validateProfileMediaMetadata(body: unknown): {
  fileName: string;
  mimeType: string;
  role: ProfileMediaRole;
  sizeBytes: number;
} | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid profile media metadata.' };
  }

  const role = normalizeRole(body.role);
  if (!role) {
    return { error: 'Choose avatar or cover profile media.' };
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  if (!mimeType || !isAllowedStorageBucketMimeType(PROFILE_MEDIA_BUCKET, mimeType)) {
    return { error: 'Upload a valid image file.' };
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'Upload size is required.' };
  }

  if (sizeBytes > MAX_PROFILE_IMAGE_BYTES) {
    return { error: 'Profile images must be 5MB or smaller.' };
  }

  const rawFileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName
    : `${role}.${inferImageExtension(mimeType, null)}`;
  const fileName = sanitizeFileName(rawFileName);
  const extension = path.extname(fileName).toLowerCase();
  if (BLOCKED_PROFILE_IMAGE_EXTENSIONS.has(extension)) {
    return { error: 'This image type is not supported for profile media.' };
  }

  return {
    fileName,
    mimeType,
    role,
    sizeBytes,
  };
}

function resolveClient(client: CreateProfileMediaUploadIntentInput['client']) {
  return typeof client === 'function' ? client() : client;
}

function createRateLimitResult(error: BackendRateLimitError): ProfileMediaUploadIntentResult {
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

export async function createProfileMediaUploadIntent({
  body,
  userId,
  client,
  createUploadId = randomUUID,
}: CreateProfileMediaUploadIntentInput): Promise<ProfileMediaUploadIntentResult> {
  const metadata = validateProfileMediaMetadata(body);
  if ('error' in metadata) {
    return {
      ok: false,
      status: 400,
      body: { error: metadata.error },
    };
  }

  const resolvedClient = resolveClient(client);
  const deletionState = await canUserCreateDurableUpload(resolvedClient, userId);
  if (!deletionState.allowed) {
    if (deletionState.error) {
      logBackendError('profile_media_account_deletion_guard_failed', {
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

  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...PROFILE_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('profile_media_upload_sign_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check profile media upload limits.' } };
  }

  const uploadPath = `${userId}/${metadata.role}-${createUploadId()}-${metadata.fileName}`;
  const byteReservation = await reserveUploadBytes(resolvedClient, {
    userId,
    bucket: PROFILE_MEDIA_BUCKET,
    storagePath: uploadPath,
    declaredBytes: metadata.sizeBytes,
  });
  if (!byteReservation.ok) {
    return {
      ok: false,
      status: byteReservation.status,
      body: { error: byteReservation.error, code: byteReservation.code },
    };
  }
  const profileStorage = resolvedClient.storage.from(PROFILE_MEDIA_BUCKET);
  const { data, error } = await profileStorage.createSignedUploadUrl(uploadPath);

  if (error || !data?.token) {
    await releaseUploadBytes(resolvedClient, {
      bucket: PROFILE_MEDIA_BUCKET,
      storagePath: uploadPath,
    });
    logBackendError('failed_to_create_profile_media_signed_upload_url', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to prepare profile media upload.' } };
  }

  const {
    data: { publicUrl },
  } = profileStorage.getPublicUrl(uploadPath);

  if (!publicUrl) {
    await releaseUploadBytes(resolvedClient, {
      bucket: PROFILE_MEDIA_BUCKET,
      storagePath: uploadPath,
    });
    return { ok: false, status: 500, body: { error: 'Failed to prepare profile media URL.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      bucket: PROFILE_MEDIA_BUCKET,
      path: uploadPath,
      token: data.token,
      signedUploadUrl: data.signedUrl ?? null,
      publicUrl,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
    },
  };
}
