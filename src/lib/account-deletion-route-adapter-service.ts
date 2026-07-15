import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  ACCOUNT_DELETION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const USER_PREFIX_BUCKETS = [
  'profiles',
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'post_resource_files',
  'template_inputs',
] as const;
const RECENT_AUTH_MAX_AGE_MS = 15 * 60 * 1000;
const RECENT_AUTH_FUTURE_SKEW_MS = 60 * 1000;
const TEMPLATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AccountDeletionStorageManifest = {
  userPrefixBuckets: Array<(typeof USER_PREFIX_BUCKETS)[number]>;
  showcaseMediaPaths: string[];
  templateAssetPrefixes: string[];
};

type StorageEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};

type AccountDeletionDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  invalidateShowcaseFeedCache?: typeof invalidateShowcaseFeedCache;
  logError?: typeof console.error;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function isMissingBucketError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const message = 'message' in error ? String(error.message).toLowerCase() : '';
  const status = 'statusCode' in error ? String(error.statusCode) : '';
  return status === '404' || message.includes('bucket not found');
}

function isMissingAuthUserError(error: unknown) {
  if (!isRecord(error)) return false;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '404' || message.includes('user not found');
}

function hasRecentAuthentication(lastSignInAt: string | undefined, now: Date) {
  if (!lastSignInAt) return false;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAtMs)) return false;
  const ageMs = now.getTime() - signedInAtMs;
  return ageMs >= -RECENT_AUTH_FUTURE_SKEW_MS && ageMs <= RECENT_AUTH_MAX_AGE_MS;
}

function normalizedStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function parseStorageManifest(value: unknown): AccountDeletionStorageManifest | null {
  if (!isRecord(value)) return null;

  const allowedBuckets = new Set<string>(USER_PREFIX_BUCKETS);
  const userPrefixBuckets = normalizedStringArray(value.user_prefix_buckets)
    .filter((bucket): bucket is (typeof USER_PREFIX_BUCKETS)[number] => allowedBuckets.has(bucket));
  const showcaseMediaPaths = normalizedStringArray(value.showcase_media_paths)
    .filter((path) => !path.startsWith('/') && !path.includes('..') && !path.includes('\\'));
  const templateAssetPrefixes = normalizedStringArray(value.template_asset_prefixes)
    .filter((prefix) => TEMPLATE_ID_PATTERN.test(prefix));

  if (userPrefixBuckets.length !== USER_PREFIX_BUCKETS.length) return null;
  return { userPrefixBuckets, showcaseMediaPaths, templateAssetPrefixes };
}

async function listUserFiles(
  admin: ReturnType<typeof createServiceClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const files: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) {
      if (isMissingBucketError(error)) return files;
      throw new Error(`Could not inspect ${bucket} account files.`);
    }

    const entries = (data ?? []) as StorageEntry[];
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id || entry.metadata) {
        files.push(path);
      } else {
        files.push(...await listUserFiles(admin, bucket, path));
      }
    }

    if (entries.length < 1000) break;
    offset += entries.length;
  }

  return files;
}

async function removeUserStorage(
  admin: ReturnType<typeof createServiceClient>,
  userId: string,
  manifest: AccountDeletionStorageManifest,
) {
  async function removePaths(bucket: string, paths: string[]) {
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(index, index + 100));
      if (error && !isMissingBucketError(error)) {
        throw new Error(`Could not remove ${bucket} account files.`);
      }
    }
  }

  for (const bucket of manifest.userPrefixBuckets) {
    const paths = await listUserFiles(admin, bucket, userId);
    await removePaths(bucket, paths);
  }

  await removePaths('showcase_media', manifest.showcaseMediaPaths);

  for (const templatePrefix of manifest.templateAssetPrefixes) {
    const paths = await listUserFiles(admin, 'template_assets', templatePrefix);
    await removePaths('template_assets', paths);
  }
}

async function prepareAccountDeletion(
  admin: ReturnType<typeof createServiceClient>,
  userId: string,
) {
  const { data, error } = await admin.rpc('prepare_account_deletion', { p_user_id: userId });
  if (error || !isRecord(data) || !['prepared', 'already_completed'].includes(String(data.status))) {
    throw new Error(errorMessage(error, 'Could not prepare account deletion.'));
  }

  if (data.status === 'already_completed') {
    return { alreadyCompleted: true as const, manifest: null };
  }

  const manifest = parseStorageManifest(data.storage_manifest);
  if (!manifest) throw new Error('Account deletion storage manifest is invalid.');
  return { alreadyCompleted: false as const, manifest };
}

async function markAccountDeletionStage(
  admin: ReturnType<typeof createServiceClient>,
  userId: string,
  status: 'storage_deleting' | 'storage_deleted' | 'auth_deleting' | 'completed' | 'failed',
  failure?: unknown,
) {
  const { data, error } = await admin.rpc('mark_account_deletion_stage', {
    p_user_id: userId,
    p_status: status,
    p_error_message: status === 'failed'
      ? errorMessage(failure, 'Unknown deletion error').slice(0, 1000)
      : null,
  });

  if (error || !isRecord(data) || ![status, 'already_completed'].includes(String(data.status))) {
    throw new Error(errorMessage(error, `Could not persist account deletion stage ${status}.`));
  }
}

async function parseConfirmation(request: Request) {
  try {
    const body = await request.json() as { confirmation?: unknown };
    return body.confirmation === 'DELETE';
  } catch {
    return false;
  }
}

export async function deleteAccountRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: AccountDeletionDependencies;
  request: Request;
}) {
  const resolved = {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    invalidateShowcaseFeedCache: dependencies?.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache,
    logError: dependencies?.logError ?? console.error,
    now: dependencies?.now ?? (() => new Date()),
  };
  const userClient = resolved.createUserClient(request);
  const { data: { user }, error: authError } = await userClient.auth.getUser();

  if (authError || !user) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  if (!await parseConfirmation(request)) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Type DELETE to confirm permanent account deletion.' }, { status: 400 }),
      request,
    );
  }

  if (!hasRecentAuthentication(user.last_sign_in_at, resolved.now())) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        error: 'Please sign in again before permanently deleting your account.',
        code: 'RECENT_AUTH_REQUIRED',
        reauthenticate: true,
      }, { status: 403 }),
      request,
    );
  }

  const admin = resolved.createServiceClient();
  try {
    await resolved.enforceBackendRateLimit(admin, {
      ...ACCOUNT_DELETION_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return applyPrivateNoStoreApiResponseHeaders(
        createBackendRateLimitResponse(error),
        request,
      );
    }

    resolved.logError('Account deletion rate limit check failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Account deletion could not be completed. Please try again.' }, { status: 500 }),
      request,
    );
  }

  try {
    const preparation = await prepareAccountDeletion(admin, user.id);
    if (preparation.alreadyCompleted) {
      resolved.invalidateShowcaseFeedCache();
      return applyPrivateNoStoreApiResponseHeaders(
        NextResponse.json({ success: true, deleted: true, alreadyDeleted: true }),
        request,
      );
    }

    await markAccountDeletionStage(admin, user.id, 'storage_deleting');
    await removeUserStorage(admin, user.id, preparation.manifest);
    await markAccountDeletionStage(admin, user.id, 'storage_deleted');
    await markAccountDeletionStage(admin, user.id, 'auth_deleting');
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && !isMissingAuthUserError(error)) throw error;

    try {
      await markAccountDeletionStage(admin, user.id, 'completed');
    } catch (stageError) {
      // The auth-delete database trigger normally finalizes this stage in the
      // same transaction. The explicit call is an idempotent fallback; once the
      // account is gone, returning a retryable failure would be misleading.
      resolved.logError('Account deletion completion stage could not be persisted:', stageError);
    }

    resolved.invalidateShowcaseFeedCache();

    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ success: true, deleted: true }),
      request,
    );
  } catch (error) {
    try {
      await markAccountDeletionStage(admin, user.id, 'failed', error);
    } catch (stageError) {
      resolved.logError('Account deletion failure stage could not be persisted:', stageError);
    }
    resolved.logError('Account deletion failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Account deletion could not be completed. Please try again.' }, { status: 500 }),
      request,
    );
  }
}
