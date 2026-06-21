import { supabase } from '@/lib/supabase';

type ProfileMediaRole = 'avatar' | 'cover';

type ProfileMediaUploadIntent = {
  success: boolean;
  bucket: 'profiles';
  path: string;
  token: string;
  signedUploadUrl: string | null;
  publicUrl: string;
  expiresInSeconds: number;
};

export async function uploadProfileMediaWithSignedIntent({
  accessToken,
  file,
  role,
}: {
  accessToken: string;
  file: File;
  role: ProfileMediaRole;
}): Promise<{ publicUrl: string; storagePath: string }> {
  const response = await fetch('/api/profile/media/sign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      role,
      fileName: file.name,
      mimeType: file.type || 'image/jpeg',
      sizeBytes: file.size,
    }),
  });

  const uploadIntent = await response.json() as Partial<ProfileMediaUploadIntent> & { error?: string };
  if (!response.ok) {
    throw new Error(uploadIntent.error || 'Failed to prepare profile media upload.');
  }

  if (
    uploadIntent.bucket !== 'profiles'
    || !uploadIntent.path
    || !uploadIntent.token
    || !uploadIntent.publicUrl
  ) {
    throw new Error('Profile media upload response was invalid.');
  }

  const { error } = await supabase.storage
    .from(uploadIntent.bucket)
    .uploadToSignedUrl(uploadIntent.path, uploadIntent.token, file, {
      contentType: file.type || 'image/jpeg',
    });

  if (error) {
    throw new Error(`Profile media upload failed: ${error.message}`);
  }

  return {
    publicUrl: uploadIntent.publicUrl,
    storagePath: uploadIntent.path,
  };
}
