import type { SupabaseClient } from '@supabase/supabase-js';

import { uploadGenerationPreview } from '@/lib/generation-media-preview';
import { createVideoPosterBuffer } from '@/lib/video-poster';

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
