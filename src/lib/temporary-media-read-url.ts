import {
  BackendRateLimitError,
  TEMPORARY_MEDIA_UPLOAD_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { parseCanonicalStorageLocation } from '@/lib/storage-ownership';

export type TemporaryMediaReadUrlClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresInSeconds: number,
      ) => PromiseLike<{
        data: { signedUrl?: string | null } | null;
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type TemporaryMediaReadUrlResult =
  | {
    ok: true;
    response: {
      success: true;
      signedUrl: string;
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

type CreateTemporaryMediaReadUrlInput = {
  body: unknown;
  userId: string;
  client: TemporaryMediaReadUrlClient | (() => TemporaryMediaReadUrlClient);
};

const TEMPORARY_UPLOADS_BUCKET = 'uploads';
const SIGNED_READ_EXPIRES_IN_SECONDS = 60 * 60;

/**
 * A staged object can legitimately be gone -- the reclaim sweep collects
 * abandoned uploads -- and a client resuming a draft has to tell that apart
 * from a transient failure. Re-uploading on a missing object is correct;
 * dropping media because storage briefly errored is not.
 */
export const MEDIA_OBJECT_NOT_FOUND_CODE = 'MEDIA_OBJECT_NOT_FOUND';

function isMissingStorageObjectError(error: { message?: string; statusCode?: string } | Error | null) {
  if (!error) return false;
  const statusCode = (error as { statusCode?: string }).statusCode;
  return statusCode === '404'
    || /not found|does not exist/i.test(error.message ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseOwnedTemporaryMediaPath(body: unknown, userId: string): { path: string } | { error: string; status: number } {
  if (!isRecord(body) || typeof body.storagePath !== 'string') {
    return { error: 'Media path is required.', status: 400 };
  }

  const location = parseCanonicalStorageLocation(body.storagePath, {
    allowedBuckets: [TEMPORARY_UPLOADS_BUCKET],
    ownerUserId: userId,
  });
  if (!location) {
    return { error: 'Media path is not available.', status: 403 };
  }

  return { path: location.filePath };
}

function resolveClient(client: CreateTemporaryMediaReadUrlInput['client']) {
  return typeof client === 'function' ? client() : client;
}

export async function createTemporaryMediaReadUrl({
  body,
  userId,
  client,
}: CreateTemporaryMediaReadUrlInput): Promise<TemporaryMediaReadUrlResult> {
  const parsedPath = parseOwnedTemporaryMediaPath(body, userId);
  if ('error' in parsedPath) {
    return {
      ok: false,
      ...parsedPath,
    };
  }

  const resolvedClient = resolveClient(client);

  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...TEMPORARY_MEDIA_UPLOAD_READ_URL_RATE_LIMIT,
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
      error: 'Failed to check media read limits.',
    };
  }

  const { data, error } = await resolvedClient.storage
    .from(TEMPORARY_UPLOADS_BUCKET)
    .createSignedUrl(parsedPath.path, SIGNED_READ_EXPIRES_IN_SECONDS);

  if (isMissingStorageObjectError(error)) {
    return {
      ok: false,
      status: 404,
      code: MEDIA_OBJECT_NOT_FOUND_CODE,
      error: 'That upload is no longer available.',
    };
  }

  if (error || !data?.signedUrl) {
    return {
      ok: false,
      status: 500,
      error: 'Failed to prepare media preview.',
    };
  }

  return {
    ok: true,
    response: {
      success: true,
      signedUrl: data.signedUrl,
      expiresInSeconds: SIGNED_READ_EXPIRES_IN_SECONDS,
    },
  };
}
