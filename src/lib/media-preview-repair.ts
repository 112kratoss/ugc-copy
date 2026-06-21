import type { SupabaseClient } from '@supabase/supabase-js';

import { createGenerationOutputPreview } from '@/lib/generation-media-preview';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { getStoredMediaLocation } from '@/lib/server-helpers';

const MAX_PREVIEW_ATTEMPTS = 3;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

type RepairSummary = {
  attempted: number;
  completed: number;
  failed: number;
};

type GenerationRepairRow = {
  id: string;
  output_url: string;
  category: string | null;
  preview_attempt_count: number | null;
};

type PostMediaRepairRow = {
  id: string;
  storage_path: string;
  media_kind: 'image' | 'video';
  content_type: string | null;
  preview_attempt_count: number | null;
};

function hasRows(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0;
}

export function canRepairPreview(attemptCount: number | null | undefined): boolean {
  return (attemptCount ?? 0) < MAX_PREVIEW_ATTEMPTS;
}

export async function hasRepairableMediaPreviews(supabase: SupabaseClient): Promise<boolean> {
  const generationsResult = await supabase
    .from('generations')
    .select('id')
    .eq('status', 'succeeded')
    .in('category', ['image', 'video'])
    .in('preview_status', ['pending', 'failed', 'processing'])
    .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
    .not('output_url', 'is', null)
    .limit(1);

  if (generationsResult.error) throw generationsResult.error;
  if (hasRows(generationsResult.data)) return true;

  const postMediaResult = await supabase
    .from('post_media')
    .select('id')
    .in('preview_status', ['pending', 'failed', 'processing'])
    .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
    .not('storage_path', 'is', null)
    .limit(1);

  if (postMediaResult.error) throw postMediaResult.error;
  return hasRows(postMediaResult.data);
}

function previewFailure(error: unknown, attemptCount: number) {
  return {
    preview_status: 'failed',
    preview_attempt_count: Math.min(MAX_PREVIEW_ATTEMPTS, attemptCount + 1),
    preview_error: error instanceof Error ? error.message.slice(0, 500) : 'Preview generation failed.',
  };
}

async function downloadMedia(supabase: SupabaseClient, source: string): Promise<Blob> {
  const location = getStoredMediaLocation(source);
  if (location) {
    const result = await supabase.storage.from(location.bucket).download(location.filePath);
    if (result.error || !result.data) throw result.error ?? new Error('Stored media could not be downloaded.');
    return result.data;
  }

  const response = await fetch(source);
  if (!response.ok) throw new Error(`External media download failed (${response.status}).`);
  return response.blob();
}

async function repairGeneration(supabase: SupabaseClient, row: GenerationRepairRow): Promise<boolean> {
  const attempts = row.preview_attempt_count ?? 0;
  try {
    await supabase.from('generations').update({ preview_status: 'processing' }).eq('id', row.id);
    const body = await downloadMedia(supabase, row.output_url);
    const preview = await createGenerationOutputPreview({
      body,
      category: row.category,
      contentType: body.type,
      storagePath: row.output_url,
      supabase,
    });
    if (!preview) throw new Error('Media type does not support a visual preview.');

    const result = await supabase.from('generations').update({
      preview_url: preview.previewStoragePath,
      preview_thumbhash: preview.previewThumbhash,
      preview_status: 'ready',
      preview_attempt_count: attempts + 1,
      preview_error: null,
      preview_generated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    await supabase.from('generations').update(previewFailure(error, attempts)).eq('id', row.id);
    return false;
  }
}

async function repairPostMedia(supabase: SupabaseClient, row: PostMediaRepairRow): Promise<boolean> {
  const attempts = row.preview_attempt_count ?? 0;
  try {
    await supabase.from('post_media').update({ preview_status: 'processing' }).eq('id', row.id);
    const download = await supabase.storage.from(SHOWCASE_MEDIA_BUCKET).download(row.storage_path);
    if (download.error || !download.data) {
      throw download.error ?? new Error('Stored post media could not be downloaded.');
    }

    const body = download.data;
    const preview = await createPostMediaPreview({
      body,
      contentType: row.content_type || body.type,
      storagePath: row.storage_path,
      supabase,
    });
    if (!preview) throw new Error('Media type does not support a visual preview.');

    const result = await supabase.from('post_media').update({
      preview_storage_path: preview.previewStoragePath,
      preview_thumbhash: preview.previewThumbhash,
      preview_status: 'ready',
      preview_attempt_count: attempts + 1,
      preview_error: null,
      preview_generated_at: new Date().toISOString(),
      width: preview.width,
      height: preview.height,
    }).eq('id', row.id);
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    await supabase.from('post_media').update(previewFailure(error, attempts)).eq('id', row.id);
    return false;
  }
}

export async function repairMediaPreviews(
  supabase: SupabaseClient,
  options: { batchSize?: number } = {}
): Promise<RepairSummary> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 500));
  const [generationsResult, postMediaResult] = await Promise.all([
    supabase
      .from('generations')
      .select('id, output_url, category, preview_attempt_count')
      .eq('status', 'succeeded')
      .in('category', ['image', 'video'])
      .in('preview_status', ['pending', 'failed', 'processing'])
      .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
      .not('output_url', 'is', null)
      .order('completed_at', { ascending: true, nullsFirst: false })
      .limit(batchSize),
    supabase
      .from('post_media')
      .select('id, storage_path, media_kind, content_type, preview_attempt_count')
      .in('preview_status', ['pending', 'failed', 'processing'])
      .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: true })
      .limit(batchSize),
  ]);

  if (generationsResult.error) throw generationsResult.error;
  if (postMediaResult.error) throw postMediaResult.error;

  const generations = (generationsResult.data ?? []) as GenerationRepairRow[];
  const postMedia = (postMediaResult.data ?? []) as PostMediaRepairRow[];
  const results = await Promise.all([
    ...generations.filter((row) => canRepairPreview(row.preview_attempt_count)).map((row) => repairGeneration(supabase, row)),
    ...postMedia.filter((row) => canRepairPreview(row.preview_attempt_count)).map((row) => repairPostMedia(supabase, row)),
  ]);
  const completed = results.filter(Boolean).length;

  return { attempted: results.length, completed, failed: results.length - completed };
}
