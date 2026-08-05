import type { SupabaseClient } from '@supabase/supabase-js';

import { createGenerationOutputPreview } from '@/lib/generation-output-preview';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createPostMediaRendition } from '@/lib/post-media-rendition';
import { getStoredMediaLocation } from '@/lib/server-helpers';
import {
  fetchWithProviderRetry,
  PROVIDER_MEDIA_DOWNLOAD_RETRY_POLICY,
  PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const MAX_PREVIEW_ATTEMPTS = 3;
export const MAX_RENDITION_ATTEMPTS = 3;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
/**
 * Transcoding is far heavier than a poster frame, and this job shares a 300s
 * budget with the preview sweep, so renditions take a much smaller bite and run
 * one at a time. Backfill is expected to span several hourly runs.
 */
export const RENDITION_REPAIR_BATCH_SIZE = 5;
const UNRESOLVED_STATUSES = ['pending', 'processing', 'failed'] as const;

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

type PostMediaRenditionRepairRow = {
  id: string;
  storage_path: string;
  content_type: string | null;
  rendition_attempt_count: number | null;
};

function hasRows(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0;
}

export function canRepairPreview(attemptCount: number | null | undefined): boolean {
  return (attemptCount ?? 0) < MAX_PREVIEW_ATTEMPTS;
}

export function canRepairRendition(attemptCount: number | null | undefined): boolean {
  return (attemptCount ?? 0) < MAX_RENDITION_ATTEMPTS;
}

/**
 * Missing rendition columns must not take the whole sweep down: previews still
 * need repairing on a database that has not run the rendition migration.
 */
export function isMissingRenditionColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as { code?: string; message?: string };
  return (code === '42703' || code === 'PGRST204') && /rendition_/.test(message);
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
  if (hasRows(postMediaResult.data)) return true;

  // Renditions alone are enough work to justify a run; without this the job
  // would report "no repairable media" and skip the entire backfill.
  const renditionResult = await supabase
    .from('post_media')
    .select('id')
    .eq('media_kind', 'video')
    .in('rendition_status', UNRESOLVED_STATUSES)
    .lt('rendition_attempt_count', MAX_RENDITION_ATTEMPTS)
    .not('storage_path', 'is', null)
    .limit(1);

  if (renditionResult.error) {
    if (isMissingRenditionColumnError(renditionResult.error)) return false;
    throw renditionResult.error;
  }
  return hasRows(renditionResult.data);
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

  const response = await fetchWithProviderRetry(
    source,
    {},
    PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
    PROVIDER_MEDIA_DOWNLOAD_RETRY_POLICY,
    fetch,
    'Media preview source download'
  );
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

async function repairPostMediaRendition(
  supabase: SupabaseClient,
  row: PostMediaRenditionRepairRow,
): Promise<boolean> {
  const attempts = row.rendition_attempt_count ?? 0;
  try {
    await supabase.from('post_media').update({ rendition_status: 'processing' }).eq('id', row.id);
    const download = await supabase.storage.from(SHOWCASE_MEDIA_BUCKET).download(row.storage_path);
    if (download.error || !download.data) {
      throw download.error ?? new Error('Stored post media could not be downloaded.');
    }

    const body = download.data;
    const rendition = await createPostMediaRendition({
      body,
      contentType: row.content_type || body.type,
      storagePath: row.storage_path,
      supabase,
    });

    // 'skipped' is a correct terminal answer, not a failure — record it so the
    // row stops appearing in this sweep.
    if (rendition.status === 'skipped') {
      const skipResult = await supabase.from('post_media').update({
        rendition_status: 'skipped',
        rendition_attempt_count: attempts + 1,
        rendition_error: `Rendition skipped: ${rendition.reason}.`,
      }).eq('id', row.id);
      if (skipResult.error) throw skipResult.error;
      return true;
    }

    const result = await supabase.from('post_media').update({
      rendition_storage_path: rendition.renditionStoragePath,
      rendition_status: 'ready',
      rendition_attempt_count: attempts + 1,
      rendition_error: null,
      rendition_generated_at: new Date().toISOString(),
      rendition_bytes: rendition.renditionBytes,
      // Backfill the dimensions and duration the original publish never captured.
      ...(rendition.width === null ? {} : { width: rendition.width }),
      ...(rendition.height === null ? {} : { height: rendition.height }),
      ...(rendition.durationSeconds === null ? {} : { duration_seconds: rendition.durationSeconds }),
    }).eq('id', row.id);
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    await supabase.from('post_media').update({
      rendition_status: 'failed',
      rendition_attempt_count: Math.min(MAX_RENDITION_ATTEMPTS, attempts + 1),
      rendition_error: error instanceof Error ? error.message.slice(0, 500) : 'Rendition generation failed.',
    }).eq('id', row.id);
    return false;
  }
}

export async function repairPostMediaRenditions(
  supabase: SupabaseClient,
  options: { batchSize?: number } = {},
): Promise<RepairSummary> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? RENDITION_REPAIR_BATCH_SIZE, 50));
  const { data, error } = await supabase
    .from('post_media')
    .select('id, storage_path, content_type, rendition_attempt_count')
    .eq('media_kind', 'video')
    .in('rendition_status', UNRESOLVED_STATUSES)
    .lt('rendition_attempt_count', MAX_RENDITION_ATTEMPTS)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    if (isMissingRenditionColumnError(error)) {
      return { attempted: 0, completed: 0, failed: 0 };
    }
    throw error;
  }

  const rows = ((data ?? []) as PostMediaRenditionRepairRow[])
    .filter((row) => canRepairRendition(row.rendition_attempt_count));

  // Sequential on purpose: concurrent ffmpeg processes would contend for the
  // same one or two cores and push the job past its duration budget.
  let completed = 0;
  for (const row of rows) {
    if (await repairPostMediaRendition(supabase, row)) {
      completed += 1;
    }
  }

  return { attempted: rows.length, completed, failed: rows.length - completed };
}

/**
 * Repair one post's media immediately after it publishes.
 *
 * Publishing defers preview and rendition work rather than doing it inline, so
 * without this a fresh post would wait up to an hour for the sweep. The row
 * workers are the same ones the sweep uses, so overlapping with it is safe:
 * derivatives upload to deterministic paths with upsert, and 'processing' stays
 * in UNRESOLVED_STATUSES precisely so an interrupted attempt is retried.
 *
 * Bounded by a single post's media (at most five items). It CAN throw -- a
 * failed post_media read surfaces to the caller -- so anyone scheduling it
 * post-response must wrap it (both route adapters do); the hourly sweep retries
 * whatever an interrupted run left unfinished.
 */
export async function repairMediaForPost(
  supabase: SupabaseClient,
  postId: string,
  options: { invalidateFeedCache?: typeof invalidateShowcaseFeedCache } = {},
): Promise<RepairSummary> {
  const previewResult = await supabase
    .from('post_media')
    .select('id, storage_path, media_kind, content_type, preview_attempt_count')
    .eq('post_id', postId)
    .in('preview_status', ['pending', 'failed', 'processing'])
    .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
    .not('storage_path', 'is', null)
    .order('sort_order', { ascending: true });

  if (previewResult.error) throw previewResult.error;

  const previewRows = ((previewResult.data ?? []) as PostMediaRepairRow[])
    .filter((row) => canRepairPreview(row.preview_attempt_count));
  const previewOutcomes = await Promise.all(
    previewRows.map((row) => repairPostMedia(supabase, row)),
  );

  const renditionResult = await supabase
    .from('post_media')
    .select('id, storage_path, content_type, rendition_attempt_count')
    .eq('post_id', postId)
    .eq('media_kind', 'video')
    .in('rendition_status', UNRESOLVED_STATUSES)
    .lt('rendition_attempt_count', MAX_RENDITION_ATTEMPTS)
    .not('storage_path', 'is', null)
    .order('sort_order', { ascending: true });

  // A database without the rendition migration still repairs previews here,
  // exactly as the sweep does.
  let renditionRows: PostMediaRenditionRepairRow[] = [];
  if (renditionResult.error) {
    if (!isMissingRenditionColumnError(renditionResult.error)) throw renditionResult.error;
  } else {
    renditionRows = ((renditionResult.data ?? []) as PostMediaRenditionRepairRow[])
      .filter((row) => canRepairRendition(row.rendition_attempt_count));
  }

  // Sequential for the same reason the sweep is: concurrent ffmpeg processes
  // contend for the same one or two cores.
  let renditionsCompleted = 0;
  for (const row of renditionRows) {
    if (await repairPostMediaRendition(supabase, row)) {
      renditionsCompleted += 1;
    }
  }

  const completed = previewOutcomes.filter(Boolean).length + renditionsCompleted;
  const attempted = previewRows.length + renditionRows.length;

  if (completed > 0) {
    (options.invalidateFeedCache ?? invalidateShowcaseFeedCache)();
  }

  return { attempted, completed, failed: attempted - completed };
}

export async function repairMediaPreviews(
  supabase: SupabaseClient,
  options: {
    batchSize?: number;
    renditionBatchSize?: number;
    invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
  } = {}
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

  // Runs after the preview pass so poster frames — which the feed needs before
  // anything can play at all — always win the shared duration budget.
  const renditions = await repairPostMediaRenditions(supabase, {
    batchSize: options.renditionBatchSize,
  });

  const completed = results.filter(Boolean).length + renditions.completed;
  const attempted = results.length + renditions.attempted;

  if (completed > 0) {
    (options.invalidateFeedCache ?? invalidateShowcaseFeedCache)();
  }

  return { attempted, completed, failed: attempted - completed };
}
