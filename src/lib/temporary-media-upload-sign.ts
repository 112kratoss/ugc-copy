import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendRateLimitError,
  TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { canUserCreateDurableUpload } from '@/lib/account-deletion-guard';
import { recordMediaUploadIntent } from '@/lib/media-upload-intents';
import { isAllowedStorageMediaMimeType } from '@/lib/storage-upload-mime-policy';

export type TemporaryMediaUploadSignClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  // Widened for media_upload_intents. The staging bucket has no other record
  // that an object was handed out, so an upload that is signed without a row is
  // an object nothing will ever collect.
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
  };
  storage: {
    from: (bucket: string) => {
      createSignedUploadUrl: (
        path: string,
      ) => PromiseLike<{
        data: { token?: string | null; signedUrl?: string | null } | null;
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type TemporaryMediaUploadIntentResult =
  | {
    ok: true;
    response: {
      success: true;
      bucket: 'uploads';
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

type CreateTemporaryMediaUploadIntentInput = {
  body: unknown;
  userId: string;
  client: TemporaryMediaUploadSignClient | (() => TemporaryMediaUploadSignClient);
  createUploadId?: () => string;
};

const TEMPORARY_UPLOADS_BUCKET = 'uploads';
const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;
export const MAX_UPLOAD_BYTES_BY_KIND = {
  image: 25 * 1024 * 1024,
  video: 250 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
} as const;

/**
 * The sign step can only validate the size the client *claims*, because the
 * object does not exist yet. The publish step re-checks the bytes it actually
 * received against this same table -- otherwise the only real ceiling is the
 * bucket's 250 MB, and a 25 MB image cap is a suggestion.
 */
export function getMaxUploadBytesForContentType(contentType: string | null | undefined): number | null {
  const normalized = (contentType ?? '').toLowerCase();
  if (normalized.startsWith('image/')) return MAX_UPLOAD_BYTES_BY_KIND.image;
  if (normalized.startsWith('video/')) return MAX_UPLOAD_BYTES_BY_KIND.video;
  if (normalized.startsWith('audio/')) return MAX_UPLOAD_BYTES_BY_KIND.audio;
  return null;
}

export function formatUploadByteLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
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

type UploadKind = keyof typeof MAX_UPLOAD_BYTES_BY_KIND;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const stem = path.basename(fileName, extension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'media';
  // The extension is caller-supplied too, and only the stem used to be
  // sanitized -- so `clip.mp4 ` produced a key with a trailing space that
  // storage silently dropped, leaving the recorded path and the real object key
  // different strings. Everything downstream matches these by exact value.
  const safeExtension = extension.replace(/[^a-z0-9.]+/g, '');
  return `${safeStem}${safeExtension && safeExtension !== '.' ? safeExtension : '.bin'}`;
}

function normalizeUploadKind(value: unknown): UploadKind | null {
  return value === 'image' || value === 'video' || value === 'audio' ? value : null;
}

function inferExtension(mimeType: string, fileName: string | null): string {
  const extension = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (extension) return extension;
  if (mimeType === 'image/jpeg') return 'jpg';
  const [, subtype] = mimeType.split('/');
  return subtype?.split('+')[0]?.trim() || 'bin';
}

function validateUploadMetadata(body: unknown): {
  fileName: string;
  kind: UploadKind;
  mimeType: string;
  sizeBytes: number;
} | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid upload metadata.' };
  }

  const kind = normalizeUploadKind(body.kind);
  if (!kind) {
    return { error: 'Choose image, video, or audio media to upload.' };
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  if (!mimeType || !isAllowedStorageMediaMimeType(kind, mimeType)) {
    return { error: `Upload a valid ${kind} file.` };
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'Upload size is required.' };
  }

  const maxBytes = MAX_UPLOAD_BYTES_BY_KIND[kind];
  if (sizeBytes > maxBytes) {
    return { error: `${kind[0].toUpperCase()}${kind.slice(1)} uploads must be ${Math.floor(maxBytes / 1024 / 1024)}MB or smaller.` };
  }

  const rawFileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName
    : `media.${inferExtension(mimeType, null)}`;
  const fileName = sanitizeFileName(rawFileName);
  if (BLOCKED_UPLOAD_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    return { error: 'This file type is not supported for media uploads.' };
  }

  return {
    fileName,
    kind,
    mimeType,
    sizeBytes,
  };
}

function resolveClient(client: CreateTemporaryMediaUploadIntentInput['client']) {
  return typeof client === 'function' ? client() : client;
}

export async function createTemporaryMediaUploadIntent({
  body,
  userId,
  client,
  createUploadId = randomUUID,
}: CreateTemporaryMediaUploadIntentInput): Promise<TemporaryMediaUploadIntentResult> {
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
      ...TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
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
      error: 'Failed to check media upload limits.',
    };
  }

  const uploadPath = `${userId}/${createUploadId()}-${metadata.fileName}`;

  // Recorded before the URL is handed out, never after. Signing first and
  // failing here would leave an object the client can write and nothing can
  // collect; failing in this order leaves a row for an object that will never
  // exist, which the sweep drops once the signed URL lapses.
  const intent = await recordMediaUploadIntent(resolvedClient, {
    userId,
    storagePath: uploadPath,
    kind: metadata.kind,
    contentType: metadata.mimeType,
    declaredBytes: metadata.sizeBytes,
  });
  if (!intent.ok) {
    return {
      ok: false,
      status: 500,
      error: 'Failed to prepare media upload.',
    };
  }

  const { data, error } = await resolvedClient.storage
    .from(TEMPORARY_UPLOADS_BUCKET)
    .createSignedUploadUrl(uploadPath);

  if (error || !data?.token) {
    return {
      ok: false,
      status: 500,
      error: 'Failed to prepare media upload.',
    };
  }

  return {
    ok: true,
    response: {
      success: true,
      bucket: TEMPORARY_UPLOADS_BUCKET,
      path: uploadPath,
      storagePath: `${TEMPORARY_UPLOADS_BUCKET}/${uploadPath}`,
      token: data.token,
      signedUploadUrl: data.signedUrl ?? null,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
    },
  };
}
