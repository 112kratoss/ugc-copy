import { supabase } from '@/lib/supabase';
import {
  resolveSignedUploadUrl,
  uploadFileToSignedUrl,
  type SignedUrlUploadProgress,
} from '@/lib/signed-url-upload';
import { finalizeSignedUpload } from '@/lib/upload-finalize-client';

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

function inferUploadKind(file: File): 'image' | 'video' | 'audio' {
  if (file.type.startsWith('video/')) {
    return 'video';
  }
  if (file.type.startsWith('audio/')) {
    return 'audio';
  }
  return 'image';
}

export async function uploadMediaToTemporaryStorage(
  file: File,
  ownerUserId = '',
  // Optional so existing callers (and the composer tests that mock this export
  // by name) keep working unchanged.
  options: {
    onProgress?: (progress: SignedUrlUploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ signedUrl: string; storagePath: string }> {
  void ownerUserId;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Please log in to upload files.');
  }

  const mimeType = file.type || 'application/octet-stream';
  const response = await fetch('/api/uploads/media/sign', {
    method: 'POST',
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

  const readUrlResponse = await fetch('/api/uploads/media/read-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      storagePath: finalized.storagePath,
    }),
  });

  const readUrl = await readUrlResponse.json() as Partial<TemporaryMediaReadUrlResponse> & { error?: string };
  if (!readUrlResponse.ok || !readUrl.signedUrl) {
    throw new Error(readUrl.error || 'Failed to prepare media preview.');
  }

  return {
    signedUrl: readUrl.signedUrl,
    storagePath: finalized.storagePath,
  };
}
