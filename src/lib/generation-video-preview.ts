import type { SupabaseClient } from '@supabase/supabase-js';

import { uploadGenerationPreview } from '@/lib/generation-media-preview';
import { createVideoPosterBuffer, createVideoPosterBufferFromFile } from '@/lib/video-poster';

export async function createGenerationVideoPoster({
  body,
  storagePath,
  supabase,
}: {
  body: Blob;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const poster = await createVideoPosterBuffer(body);
  return uploadGenerationPreview({ preview: poster, storagePath, supabase });
}

export async function createGenerationVideoPosterFromFile({
  filePath,
  storagePath,
  supabase,
}: {
  filePath: string;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const poster = await createVideoPosterBufferFromFile(filePath);
  return uploadGenerationPreview({ preview: poster, storagePath, supabase });
}
