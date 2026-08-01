import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getUploadsBucketPath, isUploadsStoragePath } from '@/lib/image-elements';
import { getStoredMediaLocation } from '@/lib/media-urls';
import {
  getPostResourceBundleDetailByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';

export type PostResourceFileReadUrlClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresInSeconds: number,
        options: { download: string },
      ) => PromiseLike<{
        data: { signedUrl?: string | null } | null;
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type PostResourceFileReadUrlResult =
  | {
    ok: true;
    body: {
      success: true;
      signedUrl: string;
    };
  }
  | {
    ok: false;
    status: 400 | 403 | 404 | 500;
    body: {
      error: string;
    };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

type CreatePostResourceFileReadUrlParams = {
  body: unknown;
  client: PostResourceFileReadUrlClient | (() => PostResourceFileReadUrlClient);
  countryCode: string | null;
  getDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  postId: string;
  rateLimitKey: string;
  viewerUserId: string | null;
};

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const SIGNED_READ_EXPIRES_IN_SECONDS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseRequestedPath(body: unknown) {
  if (!isRecord(body) || typeof body.storagePath !== 'string') {
    return '';
  }

  return body.storagePath.trim().replace(/^\/+/, '');
}

function resolveClient(client: CreatePostResourceFileReadUrlParams['client']) {
  return typeof client === 'function' ? client() : client;
}

/**
 * A file counts as part of this unlock if it appears in the current bundle OR in
 * the revision this buyer paid for. Matching only the current version meant a
 * creator could edit a file out and silently break downloads for people who had
 * already bought it -- the exact hollowing-out the revision snapshot exists to
 * prevent.
 */
function findRequestedResource(detail: PostResourceBundleDetail, requestedPath: string) {
  const candidateResources = [detail.resources, detail.purchasedRevision?.resources]
    .filter((resources): resources is NonNullable<typeof resources> => Boolean(resources));

  for (const resources of candidateResources) {
    const attachment = resources.attachments.find(
      (item) => item.kind === 'file' && item.storagePath === requestedPath,
    ) ?? null;
    const resourceItem = resources.items?.find((item) => item.storagePath === requestedPath) ?? null;

    if (attachment || resourceItem) {
      return { attachment, resourceItem };
    }
  }

  return { attachment: null, resourceItem: null };
}

function resolveStorageLocation(requestedPath: string) {
  const storedLocation = getStoredMediaLocation(requestedPath);
  const isUploadReference = isUploadsStoragePath(requestedPath);

  return {
    bucket: isUploadReference ? 'uploads' : storedLocation?.bucket ?? RESOURCE_FILES_BUCKET,
    filePath: isUploadReference
      ? getUploadsBucketPath(requestedPath)
      : storedLocation?.filePath ?? requestedPath,
  };
}

export async function createPostResourceFileReadUrlForRoute({
  body,
  client,
  countryCode,
  getDetailByPostId = getPostResourceBundleDetailByPostId,
  postId,
  rateLimitKey,
  viewerUserId,
}: CreatePostResourceFileReadUrlParams): Promise<PostResourceFileReadUrlResult> {
  const requestedPath = parseRequestedPath(body);
  if (!requestedPath) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing resource file path.' },
    };
  }

  const detail = await getDetailByPostId(postId, {
    viewerUserId,
    countryCode,
  });

  if (!detail || !detail.viewerCanAccess || !detail.resources) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Unlock this resource before downloading files.' },
    };
  }

  const { attachment, resourceItem } = findRequestedResource(detail, requestedPath);
  if (!attachment && !resourceItem) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Resource file not found on this unlock.' },
    };
  }

  const resolvedClient = resolveClient(client);
  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
      key: rateLimitKey,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        rateLimitError: error,
      };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check resource file limits.' },
    };
  }

  const { bucket, filePath } = resolveStorageLocation(requestedPath);
  const { data, error } = await resolvedClient.storage
    .from(bucket)
    .createSignedUrl(filePath, SIGNED_READ_EXPIRES_IN_SECONDS, {
      download: attachment?.label ?? resourceItem?.title ?? 'Resource file',
    });

  if (error || !data?.signedUrl) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare resource file.' },
    };
  }

  return {
    ok: true,
    body: {
      success: true,
      signedUrl: data.signedUrl,
    },
  };
}
