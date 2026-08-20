import {
  BackendRateLimitError,
  WORKFLOW_ASSET_UPLOAD_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { parseCanonicalStorageLocation } from '@/lib/storage-ownership';

export type WorkflowAssetReadUrlClient = Parameters<typeof enforceBackendRateLimit>[0] & {
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

export type WorkflowAssetReadUrlResult =
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

type CreateWorkflowAssetReadUrlInput = {
  body: unknown;
  userId: string;
  client: WorkflowAssetReadUrlClient | (() => WorkflowAssetReadUrlClient);
};

const SIGNED_READ_EXPIRES_IN_SECONDS = 60 * 60;
const WORKFLOW_ASSET_BUCKETS = new Set(['generated_images', 'generated_videos', 'generated_audio']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseOwnedWorkflowAssetPath(body: unknown, userId: string): {
  bucket: string;
  path: string;
} | { error: string; status: number } {
  if (!isRecord(body) || typeof body.storagePath !== 'string') {
    return { error: 'Workflow asset path is required.', status: 400 };
  }

  const location = parseCanonicalStorageLocation(body.storagePath, {
    allowedBuckets: WORKFLOW_ASSET_BUCKETS,
    ownerUserId: userId,
  });
  if (!location) {
    return { error: 'Workflow asset path is not available.', status: 403 };
  }

  return { bucket: location.bucket, path: location.filePath };
}

function resolveClient(client: CreateWorkflowAssetReadUrlInput['client']) {
  return typeof client === 'function' ? client() : client;
}

export async function createWorkflowAssetReadUrl({
  body,
  client,
  userId,
}: CreateWorkflowAssetReadUrlInput): Promise<WorkflowAssetReadUrlResult> {
  const parsedPath = parseOwnedWorkflowAssetPath(body, userId);
  if ('error' in parsedPath) {
    return {
      ok: false,
      ...parsedPath,
    };
  }

  const resolvedClient = resolveClient(client);

  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...WORKFLOW_ASSET_UPLOAD_READ_URL_RATE_LIMIT,
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
      error: 'Failed to check workflow asset read limits.',
    };
  }

  const { data, error } = await resolvedClient.storage
    .from(parsedPath.bucket)
    .createSignedUrl(parsedPath.path, SIGNED_READ_EXPIRES_IN_SECONDS);

  if (error || !data?.signedUrl) {
    return {
      ok: false,
      status: 500,
      error: 'Failed to prepare workflow asset preview.',
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
