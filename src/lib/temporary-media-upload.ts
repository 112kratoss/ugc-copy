import { supabase } from '@/lib/supabase';
import {
  resolveSignedUploadUrl,
  uploadFileToSignedUrl,
  type SignedUrlUploadProgress,
} from '@/lib/signed-url-upload';
import {
  isAllowedStorageMediaMimeType,
  type StorageMediaKind,
} from '@/lib/storage-upload-mime-policy';
import { finalizeSignedUpload } from '@/lib/upload-finalize-client';
import { UploadCancelledError } from '@/lib/upload-queue';

type TemporaryMediaUploadIntent = {
  success: boolean;
  uploadId: string;
  bucket: 'uploads';
  path: string;
  storagePath: string;
  token: string;
  signedUploadUrl: string | null;
  expiresInSeconds: number;
};

type TemporaryMediaReadUrlResponse = {
  success: boolean;
  signedUrl: string;
  expiresInSeconds: number;
};

export type TemporaryMediaUploadOptions = {
  onProgress?: (progress: SignedUrlUploadProgress) => void;
  signal?: AbortSignal;
};

export type TemporaryMediaUpload = { signedUrl: string; storagePath: string };

/**
 * What the sign step refuses, for a picker to check when a file is added
 * rather than after the creator presses Generate. The byte caps copy
 * MAX_UPLOAD_BYTES_BY_KIND in temporary-media-upload-sign.ts, which is server
 * code a client bundle cannot import; a test holds the two equal. The type
 * check is the sign step's own allow-list.
 */
export const TEMPORARY_MEDIA_UPLOAD_LIMITS = {
  maxBytesByKind: {
    image: 25 * 1024 * 1024,
    video: 250 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
  } as const satisfies Record<StorageMediaKind, number>,
  isAllowedMimeType: (kind: StorageMediaKind, type: string): boolean => isAllowedStorageMediaMimeType(kind, type),
};

/**
 * A read-url refusal. `status` 404 with `code` MEDIA_OBJECT_NOT_FOUND means the
 * staged object is gone (the reclaim sweep took it) and the file must be
 * uploaded again; anything else may pass on a retry.
 */
export class TemporaryMediaReadUrlError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'TemporaryMediaReadUrlError';
  }
}

function inferUploadKind(file: File): 'image' | 'video' | 'audio' {
  if (file.type.startsWith('video/')) {
    return 'video';
  }
  if (file.type.startsWith('audio/')) {
    return 'audio';
  }
  return 'image';
}

async function requestTemporaryMediaReadUrl(
  accessToken: string,
  storagePath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch('/api/uploads/media/read-url', {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ storagePath }),
  });

  let readUrl: Partial<TemporaryMediaReadUrlResponse> & { error?: string; code?: string } = {};
  try {
    readUrl = await response.json();
  } catch {
    // A gateway page instead of JSON: the status below still says what happened.
  }
  if (!response.ok || !readUrl.signedUrl) {
    throw new TemporaryMediaReadUrlError(
      readUrl.error || 'Failed to prepare media preview.',
      response.ok ? 502 : response.status,
      typeof readUrl.code === 'string' ? readUrl.code : null,
    );
  }
  return readUrl.signedUrl;
}

/**
 * A fresh signed link for media already staged in `uploads`, so a reference
 * the creator sends again goes as its staged path instead of being uploaded
 * a second time.
 */
export async function refreshTemporaryMediaUrl(
  storagePath: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Please log in to upload files.');
  }
  return requestTemporaryMediaReadUrl(session.access_token, storagePath, signal);
}

export function uploadMediaToTemporaryStorage(
  file: File,
  options?: TemporaryMediaUploadOptions,
): Promise<TemporaryMediaUpload>;
/**
 * @deprecated The upload always belongs to the signed-in session; this id was
 * never read. Pass the options second.
 */
export function uploadMediaToTemporaryStorage(
  file: File,
  ownerUserId: string,
  options?: TemporaryMediaUploadOptions,
): Promise<TemporaryMediaUpload>;
export async function uploadMediaToTemporaryStorage(
  file: File,
  optionsOrOwnerUserId: TemporaryMediaUploadOptions | string = {},
  legacyOptions: TemporaryMediaUploadOptions = {},
): Promise<TemporaryMediaUpload> {
  const options = typeof optionsOrOwnerUserId === 'string' ? legacyOptions : optionsOrOwnerUserId;
  if (options.signal?.aborted) throw new UploadCancelledError();
  const { data: { session } } = await supabase.auth.getSession();
  if (options.signal?.aborted) throw new UploadCancelledError();
  if (!session?.access_token) {
    throw new Error('Please log in to upload files.');
  }

  const mimeType = file.type || 'application/octet-stream';
  const response = await fetch('/api/uploads/media/sign', {
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      fileName: file.name || 'media.bin',
      mimeType,
      kind: inferUploadKind(file),
      sizeBytes: file.size,
    }),
  });

  const uploadIntent = await response.json() as Partial<TemporaryMediaUploadIntent> & { error?: string };
  if (!response.ok) {
    throw new Error(uploadIntent.error || 'Failed to prepare media upload.');
  }

  if (
    uploadIntent.bucket !== 'uploads'
    || !uploadIntent.path
    || !uploadIntent.storagePath
    || !uploadIntent.uploadId
    || !uploadIntent.token
  ) {
    throw new Error('Media upload response was invalid.');
  }

  // Raw PUT rather than supabase-js: uploadToSignedUrl goes through fetch, which
  // cannot report upload progress or be cancelled mid-transfer.
  await uploadFileToSignedUrl(
    file,
    resolveSignedUploadUrl({
      bucket: uploadIntent.bucket,
      path: uploadIntent.path,
      token: uploadIntent.token,
      signedUploadUrl: uploadIntent.signedUploadUrl,
    }),
    { mimeType, onProgress: options.onProgress, signal: options.signal },
  );

  const finalized = await finalizeSignedUpload(
    session.access_token,
    uploadIntent.uploadId,
    options.signal,
  );
  if (finalized.bucket !== uploadIntent.bucket || finalized.path !== uploadIntent.path) {
    throw new Error('Finalized media upload did not match its signed target.');
  }

  return {
    signedUrl: await requestTemporaryMediaReadUrl(session.access_token, finalized.storagePath, options.signal),
    storagePath: finalized.storagePath,
  };
}
