import 'server-only';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendRateLimitError,
  POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { PostResourceAttachment } from '@/lib/post-resource-bundles';

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const ALLOWED_RESOURCE_FILE_EXTENSIONS = new Set([
  '.json',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.yaml',
  '.yml',
  '.pdf',
  '.zip',
  '.gz',
  '.workflow',
]);
const ALLOWED_RESOURCE_FILE_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/gzip',
  'application/x-gzip',
  'application/zip',
  'application/x-zip-compressed',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/yaml',
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

function sanitizeFileName(fileName: string): string {
  const originalExtension = path.extname(fileName);
  const extension = originalExtension.toLowerCase();
  const stem = path.basename(fileName, originalExtension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'resource';
  return `${safeStem}${extension || '.bin'}`;
}

function isAllowedResourceFile(file: File): boolean {
  const extension = path.extname(file.name).toLowerCase();
  const contentType = file.type.toLowerCase();

  if (BLOCKED_RESOURCE_FILE_EXTENSIONS.has(extension)) {
    return false;
  }

  if (contentType && ALLOWED_RESOURCE_FILE_TYPES.has(contentType)) {
    return true;
  }

  return ALLOWED_RESOURCE_FILE_EXTENSIONS.has(extension);
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

    console.error('Post resource file upload rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check resource upload limits.' } };
  }

  const formData = await readFormData();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size <= 0) {
    return { ok: false, status: 400, body: { error: 'Choose a workflow or resource file to upload.' } };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, status: 400, body: { error: 'Resource files must be 50MB or smaller.' } };
  }

  if (!isAllowedResourceFile(file)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Upload a safe workflow or resource file: JSON, text, markdown, CSV, YAML, PDF, ZIP, or workflow export.',
      },
    };
  }

  const safeName = sanitizeFileName(file.name);
  const storagePath = `${userId}/${createUploadId()}-${safeName}`;
  const { error: uploadError } = await client.storage
    .from(RESOURCE_FILES_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    console.error('Failed to upload post resource file:', uploadError);
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
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      },
    },
  };
}
