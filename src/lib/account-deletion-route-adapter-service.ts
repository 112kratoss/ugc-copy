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

type StorageEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};

type AccountDeletionDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof console.error;
};

function isMissingBucketError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const message = 'message' in error ? String(error.message).toLowerCase() : '';
  const status = 'statusCode' in error ? String(error.statusCode) : '';
  return status === '404' || message.includes('bucket not found');
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
) {
  for (const bucket of USER_PREFIX_BUCKETS) {
    const paths = await listUserFiles(admin, bucket, userId);
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(index, index + 100));
      if (error) throw new Error(`Could not remove ${bucket} account files.`);
    }
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
    logError: dependencies?.logError ?? console.error,
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
    await removeUserStorage(admin, user.id);
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw error;

    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ success: true, deleted: true }),
      request,
    );
  } catch (error) {
    resolved.logError('Account deletion failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Account deletion could not be completed. Please try again.' }, { status: 500 }),
      request,
    );
  }
}
