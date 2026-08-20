import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  PROFILE_MEDIA_UPLOAD_CLEANUP_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

const PROFILE_MEDIA_BUCKET = 'profiles';
const MAX_CLEANUP_PATHS = 4;

export type ProfileMediaCleanupClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: typeof PROFILE_MEDIA_BUCKET) => {
      remove: (
        paths: string[],
      ) => PromiseLike<{
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type ProfileMediaCleanupResult =
  | {
      ok: true;
      body: { success: true };
    }
  | {
      ok: false;
      status: 400 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CleanupProfileMediaInput = {
  body: unknown;
  userId: string;
  client: ProfileMediaCleanupClient | (() => ProfileMediaCleanupClient);
};

function readCleanupPaths(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const paths = (value as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_CLEANUP_PATHS) {
    return null;
  }

  const normalized = paths
    .filter((path): path is string => typeof path === 'string')
    .filter(Boolean);

  return normalized.length === paths.length ? normalized : null;
}

function resolveClient(client: CleanupProfileMediaInput['client']) {
  return typeof client === 'function' ? client() : client;
}

function invalidCleanupRequest(): ProfileMediaCleanupResult {
  return {
    ok: false,
    status: 400,
    body: { error: 'Invalid profile media cleanup request.' },
  };
}

function createRateLimitResult(error: BackendRateLimitError): ProfileMediaCleanupResult {
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

export async function cleanupProfileMedia({
  body,
  userId,
  client,
}: CleanupProfileMediaInput): Promise<ProfileMediaCleanupResult> {
  const paths = readCleanupPaths(body);
  const canonicalPaths = paths?.map((path) => parseCanonicalStorageObjectPath(path, {
    ownerUserId: userId,
  })) ?? null;
  if (!canonicalPaths || canonicalPaths.some((path) => !path)) {
    return invalidCleanupRequest();
  }

  const resolvedClient = resolveClient(client);
  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...PROFILE_MEDIA_UPLOAD_CLEANUP_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('profile_media_cleanup_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check profile media cleanup limits.' } };
  }

  const { error } = await resolvedClient.storage
    .from(PROFILE_MEDIA_BUCKET)
    .remove(canonicalPaths as string[]);
  if (error) {
    logBackendError('failed_to_clean_up_profile_media', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to clean up profile media.' } };
  }

  return { ok: true, body: { success: true } };
}
