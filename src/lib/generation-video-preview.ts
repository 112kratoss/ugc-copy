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
  sourceLeaseFd,
  storagePath,
  supabase,
}: {
  filePath: string;
  sourceLeaseFd?: number;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const poster = await createVideoPosterBufferFromFile(filePath, sourceLeaseFd);
  return uploadGenerationPreview({ preview: poster, storagePath, supabase });
}
