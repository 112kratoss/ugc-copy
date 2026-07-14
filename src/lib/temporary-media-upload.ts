import { supabase } from '@/lib/supabase';

type TemporaryMediaUploadIntent = {
  success: boolean;
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
  ownerUserId = ''
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
    || !uploadIntent.token
  ) {
    throw new Error('Media upload response was invalid.');
  }

  const { error: uploadError } = await supabase.storage.from(uploadIntent.bucket).uploadToSignedUrl(
    uploadIntent.path,
    uploadIntent.token,
    file,
    { contentType: mimeType }
  );

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  const readUrlResponse = await fetch('/api/uploads/media/read-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      storagePath: uploadIntent.storagePath,
    }),
  });

  const readUrl = await readUrlResponse.json() as Partial<TemporaryMediaReadUrlResponse> & { error?: string };
  if (!readUrlResponse.ok || !readUrl.signedUrl) {
    throw new Error(readUrl.error || 'Failed to prepare media preview.');
  }

  return {
    signedUrl: readUrl.signedUrl,
    storagePath: uploadIntent.storagePath,
  };
}
