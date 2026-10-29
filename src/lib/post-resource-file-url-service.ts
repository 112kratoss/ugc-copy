import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendError } from '@/lib/backend-logger';
import {
  POST_RESOURCE_FILE_URL_BATCH_LIMIT,
  formatPostResourceDownloadName,
  type PostResourceFileDisposition,
  type PostResourceSignedFileUrl,
} from '@/lib/post-resource-bundles';
import {
  getPostResourceBundleDetailByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';
import {
  getCanonicalStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

export type PostResourceFileReadUrlClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresInSeconds: number,
        options: { download?: string },
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
    ok: true;
    body: {
      files: PostResourceSignedFileUrl[];
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

type FileUrlRequest =
  | {
    ok: true;
    /** `{ storagePaths }` answers `{ files }`; `{ storagePath }` keeps its `{ success, signedUrl }`. */
    batch: boolean;
    storagePaths: string[];
    disposition: PostResourceFileDisposition;
  }
  | { ok: false; error: string };

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const RESOURCE_SOURCE_BUCKETS = [
  RESOURCE_FILES_BUCKET,
  'uploads',
  'generation_inputs',
  'generated_images',
  'generated_videos',
  'generated_audio',
] as const;
const SIGNED_READ_EXPIRES_IN_SECONDS = 600;
const NOT_ON_THIS_UNLOCK = 'Resource file not found on this unlock.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isExactPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function parseFileUrlRequest(body: unknown): FileUrlRequest {
  const fields = isRecord(body) ? body : {};
  const disposition = fields.disposition ?? 'attachment';
  if (disposition !== 'inline' && disposition !== 'attachment') {
    return { ok: false, error: 'Unknown file disposition.' };
  }

  if (fields.storagePaths === undefined) {
    return isExactPath(fields.storagePath)
      ? { ok: true, batch: false, storagePaths: [fields.storagePath], disposition }
      : { ok: false, error: 'Missing resource file path.' };
  }

  const storagePaths = fields.storagePaths;
  if (!Array.isArray(storagePaths) || storagePaths.length === 0 || !storagePaths.every(isExactPath)) {
    return { ok: false, error: 'Missing resource file path.' };
  }
  if (storagePaths.length > POST_RESOURCE_FILE_URL_BATCH_LIMIT) {
    return {
      ok: false,
      error: `Ask for at most ${POST_RESOURCE_FILE_URL_BATCH_LIMIT} resource files at a time.`,
    };
  }

  return { ok: true, batch: true, storagePaths: Array.from(new Set(storagePaths)), disposition };
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

function resolveStorageLocation(requestedPath: string, ownerUserId: string) {
  const storedLocation = getCanonicalStoredMediaLocation(requestedPath, {
    allowedBuckets: RESOURCE_SOURCE_BUCKETS,
    ownerUserId,
  });
  if (storedLocation) return storedLocation;

  const filePath = parseCanonicalStorageObjectPath(requestedPath, { ownerUserId });
  return filePath ? { bucket: RESOURCE_FILES_BUCKET, filePath } : null;
}

function findSignableFile(detail: PostResourceBundleDetail, storagePath: string, ownerUserId: string) {
  const { attachment, resourceItem } = findRequestedResource(detail, storagePath);
  if (!attachment && !resourceItem) {
    return null;
  }

  const location = resolveStorageLocation(storagePath, ownerUserId);
  return location
    ? {
      storagePath,
      location,
      downloadName: formatPostResourceDownloadName(
        attachment?.label ?? resourceItem?.title,
        attachment?.contentType ?? resourceItem?.contentType,
      ),
    }
    : null;
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
  const request = parseFileUrlRequest(body);
  if (!request.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: request.error },
    };
  }

  // One entitlement load answers the whole request: a panel used to sign one
  // file per call, and every call loaded the bundle, purchase and post again.
  const detail = await getDetailByPostId(postId, {
    viewerUserId,
    countryCode,
    countLockedReferences: false,
  });

  if (!detail || !detail.viewerCanAccess || !detail.resources) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Unlock this resource before downloading files.' },
    };
  }

  const resourceOwnerUserId = detail.seller?.id;
  // A path that is not on this unlock is left out of a batch's answer rather
  // than failing the paths beside it; the caller reads its absence.
  const signableFiles = resourceOwnerUserId
    ? request.storagePaths.flatMap((storagePath) => {
      const file = findSignableFile(detail, storagePath, resourceOwnerUserId);
      return file ? [file] : [];
    })
    : [];
  if (signableFiles.length === 0) {
    return {
      ok: false,
      status: 404,
      body: { error: NOT_ON_THIS_UNLOCK },
    };
  }

  const resolvedClient = resolveClient(client);
  try {
    // Once per request, so a batch counts as one signing against the limit.
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

  // Taken before signing, so the stated expiry is never later than the URL's own.
  const expiresAt = new Date(Date.now() + SIGNED_READ_EXPIRES_IN_SECONDS * 1000).toISOString();
  const signedFiles = await Promise.all(signableFiles.map(async (file): Promise<PostResourceSignedFileUrl | null> => {
    try {
      const { data, error } = await resolvedClient.storage
        .from(file.location.bucket)
        // Without `download` storage serves the file inline, so "Open file"
        // opens it instead of saving it.
        .createSignedUrl(
          file.location.filePath,
          SIGNED_READ_EXPIRES_IN_SECONDS,
          request.disposition === 'attachment' ? { download: file.downloadName } : {},
        );
      return error || !data?.signedUrl ? null : { storagePath: file.storagePath, url: data.signedUrl, expiresAt };
    } catch (error) {
      logBackendError('post_resource_file_sign_failed', { error });
      return null;
    }
  }));
  const files = signedFiles.filter((file): file is PostResourceSignedFileUrl => Boolean(file));

  if (files.length === 0) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare resource file.' },
    };
  }

  if (!request.batch) {
    return {
      ok: true,
      body: {
        success: true,
        signedUrl: files[0].url,
      },
    };
  }

  return {
    ok: true,
    body: { files },
  };
}
