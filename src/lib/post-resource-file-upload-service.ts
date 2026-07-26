import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { PostResourceAttachment } from '@/lib/post-resource-bundles';

const RESOURCE_FILES_BUCKET = 'post_resource_files';
export const MAX_POST_RESOURCE_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const RESOURCE_FILE_CONTENT_TYPE_BY_EXTENSION = new Map([
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.workflow', 'application/json'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
]);
const ALLOWED_RESOURCE_FILE_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/pdf',
  'application/gzip',
  'application/octet-stream',
  'application/x-yaml',
  'application/x-gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/yaml',
  'text/comma-separated-values',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/x-markdown',
  'text/x-yaml',
  'text/yaml',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
]);
const BLOCKED_RESOURCE_FILE_EXTENSIONS = new Set([
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

export type PostResourceFileUploadClient = Parameters<typeof enforceBackendRateLimit>[0] & {
  storage: {
    from: (bucket: typeof RESOURCE_FILES_BUCKET) => {
      upload: (
        path: string,
        file: File,
        options: {
          cacheControl: string;
          contentType: string;
          upsert: boolean;
        },
      ) => PromiseLike<{
        data: unknown;
        error: { message?: string } | Error | null;
      }>;
    };
  };
};

export type PostResourceFileUploadResult =
  | {
      ok: true;
      body: {
        success: true;
        attachment: PostResourceAttachment;
      };
    }
  | {
      ok: false;
      status: 400 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type UploadPostResourceFileParams = {
  client: PostResourceFileUploadClient;
  userId: string;
  readFormData: () => Promise<FormData>;
  createUploadId?: () => string;
};

export function sanitizePostResourceFileName(fileName: string): string {
  const originalExtension = path.extname(fileName);
  const extension = originalExtension.toLowerCase();
  const stem = path.basename(fileName, originalExtension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'resource';
  return `${safeStem}${extension || '.bin'}`;
}

export function resolveResourceFileContentType(file: Pick<File, 'name' | 'type'>): string | null {
  const extension = path.extname(file.name).toLowerCase();
  const contentType = file.type.toLowerCase();

  if (BLOCKED_RESOURCE_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  const inferredContentType = RESOURCE_FILE_CONTENT_TYPE_BY_EXTENSION.get(extension);
  if (!inferredContentType) {
    return null;
  }

  if (!contentType || contentType === 'application/octet-stream') {
    return inferredContentType;
  }

  const inferredMediaFamily = /^(image|video|audio)\//.exec(inferredContentType)?.[1] ?? null;
  if (inferredMediaFamily && !contentType.startsWith(`${inferredMediaFamily}/`)) {
    return null;
  }

  return ALLOWED_RESOURCE_FILE_TYPES.has(contentType) ? contentType : null;
}

function createRateLimitResult(error: BackendRateLimitError): PostResourceFileUploadResult {
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

export async function uploadPostResourceFileForRoute({
  client,
  userId,
  readFormData,
  createUploadId = randomUUID,
}: UploadPostResourceFileParams): Promise<PostResourceFileUploadResult> {
  try {
    await enforceBackendRateLimit(client, {
      ...POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('post_resource_file_upload_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check resource upload limits.' } };
  }

  const formData = await readFormData();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size <= 0) {
    return { ok: false, status: 400, body: { error: 'Choose a workflow or resource file to upload.' } };
  }

  if (file.size > MAX_POST_RESOURCE_FILE_SIZE_BYTES) {
    return { ok: false, status: 400, body: { error: 'Resource files must be 50MB or smaller.' } };
  }

  const contentType = resolveResourceFileContentType(file);
  if (!contentType) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Upload a safe image, video, audio, workflow, document, or archive resource file.',
      },
    };
  }

  const safeName = sanitizePostResourceFileName(file.name);
  const storagePath = `${userId}/${createUploadId()}-${safeName}`;
  const { error: uploadError } = await client.storage
    .from(RESOURCE_FILES_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType,
      upsert: false,
    });

  if (uploadError) {
    logBackendError('failed_to_upload_post_resource_file', { error: uploadError });
    return { ok: false, status: 500, body: { error: 'Failed to upload resource file.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      attachment: {
        label: file.name,
        kind: 'file',
        storagePath,
        contentType,
        sizeBytes: file.size,
      },
    },
  };
}
