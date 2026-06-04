import { supabase } from '@/lib/supabase';

function inferUploadExtension(file: File): string {
  const extension = file.name.split('.').pop()?.trim().toLowerCase();
  if (extension) {
    return extension;
  }

  if (file.type.startsWith('image/')) {
    return file.type.split('/')[1] || 'jpg';
  }

  if (file.type.startsWith('video/')) {
    return file.type.split('/')[1] || 'mp4';
  }

  return 'bin';
}

export async function uploadMediaToTemporaryStorage(
  file: File,
  ownerUserId: string
): Promise<{ storagePath: string }> {
  const fileName = `${ownerUserId}/${Math.random().toString(36).slice(2)}.${inferUploadExtension(file)}`;
  const { error } = await supabase.storage.from('uploads').upload(fileName, file, {
    cacheControl: '3600',
    contentType: file.type || undefined,
    upsert: false,
  });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  return {
    storagePath: `uploads/${fileName}`,
  };
}
