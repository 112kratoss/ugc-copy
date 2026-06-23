import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createGenerationImagePreview,
  isImageGenerationPreview,
  isVideoGenerationPreview,
} from '@/lib/generation-media-preview';
import { createGenerationVideoPoster } from '@/lib/generation-video-preview';

export async function createGenerationOutputPreview({
  body,
  category,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  category: string | null | undefined;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const resolvedContentType = contentType || body.type || null;
  if (isImageGenerationPreview(category, resolvedContentType)) {
    return createGenerationImagePreview({ body, storagePath, supabase });
  }

  if (!isVideoGenerationPreview(category, resolvedContentType)) {
    return null;
  }

  return createGenerationVideoPoster({
    body,
    storagePath,
    supabase,
  });
}
