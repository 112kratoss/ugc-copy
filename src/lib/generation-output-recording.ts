import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import { GenerationServiceError } from '@/lib/generation-service-core';
import { getCanonicalStoredMediaLocation, getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * What a finished run uploads before any row names it, and what happens to the
 * uploads no row ends up naming.
 *
 * Persisting a provider's output writes the original, its preview and its
 * display rendition into the owner's folder of the generated buckets, then
 * settles the run, which records the original and the preview, and then
 * stamps the display rendition conditioned on the original. When the
 * settlement finds the run already failed (the reaper gave up on it), or gone
 * (its owner deleted it while it rendered), or the stamp finds the row moved to
 * another original, those uploads are named by nothing, and nothing reads them
 * again.
 *
 * The same rule as the media sweeps' (`queueUnrecordedShowcaseMedia`): what was
 * uploaded, minus what the row names, goes. These files sit in a private
 * bucket the revocation queue does not serve, and no lease guards them: each
 * name belongs to this run alone (the original is named by its prediction, its
 * derivatives by the original's path and their own bytes), so a run made again
 * writes the same names and records them. The row is read back first, and a
 * read that fails, or a write whose outcome is unknown, removes nothing.
 */

const GENERATED_MEDIA_BUCKETS = ['generated_images', 'generated_videos', 'generated_audio'] as const;

/** The columns of a generation that name its stored files. */
export const GENERATION_OUTPUT_NAMING_COLUMNS = 'id, output_url, preview_url, display_url, workflow_settings';

type GenerationNamingRow = {
  output_url?: string | null;
  preview_url?: string | null;
  display_url?: string | null;
  workflow_settings?: unknown;
};

/** A settlement that found no run to settle: deleted by its owner while it rendered. */
export function isGenerationGoneSettlementError(error: unknown): boolean {
  return error instanceof GenerationServiceError && error.status === 404;
}

function canonicalKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const location = getCanonicalStoredMediaLocation(value, { allowedBuckets: GENERATED_MEDIA_BUCKETS });
  return location ? `${location.bucket}/${location.filePath}` : null;
}

function namedStorageKeys(row: GenerationNamingRow): Set<string> {
  const outputs = row.workflow_settings && typeof row.workflow_settings === 'object'
    ? (row.workflow_settings as { outputs?: unknown }).outputs
    : null;
  const values = [
    row.output_url,
    row.preview_url,
    row.display_url,
    ...(Array.isArray(outputs)
      ? outputs.map((output) => (output && typeof output === 'object'
        ? (output as { storagePath?: unknown }).storagePath
        : null))
      : []),
  ];
  return new Set(values.flatMap((value) => {
    const key = typeof value === 'string' ? canonicalKey(value) : null;
    return key ? [key] : [];
  }));
}

/**
 * Removes what this run uploaded that the row (as given, or read back by id
 * when not given) does not name. Only paths in the owner's folder of the
 * generated buckets are ever removed. Never throws.
 */
export async function removeUnrecordedGenerationOutputs(
  supabase: SupabaseClient,
  {
    generationId,
    ownerUserId,
    uploaded,
    row,
  }: {
    generationId: string;
    ownerUserId: string;
    uploaded: ReadonlyArray<string | null | undefined>;
    /** The row as a write just returned it; null when it is known to be gone. */
    row?: GenerationNamingRow | null;
  },
): Promise<void> {
  const candidates = new Map<string, { bucket: string; filePath: string }>();
  for (const value of uploaded) {
    if (!value) continue;
    const location = getUserOwnedStoredMediaLocation(value, ownerUserId, { allowedBuckets: GENERATED_MEDIA_BUCKETS });
    if (location) candidates.set(`${location.bucket}/${location.filePath}`, location);
  }
  if (candidates.size === 0) return;

  let current = row;
  if (current === undefined) {
    try {
      const { data, error } = await supabase
        .from('generations')
        .select(GENERATION_OUTPUT_NAMING_COLUMNS)
        .eq('id', generationId)
        .maybeSingle();
      if (error) throw error;
      current = (data as GenerationNamingRow | null) ?? null;
    } catch (error) {
      logBackendWarning('generation_unrecorded_outputs_kept', { generationId, error });
      return;
    }
  }

  const named = current ? namedStorageKeys(current) : new Set<string>();
  const unnamedByBucket = new Map<string, string[]>();
  for (const [key, location] of candidates) {
    if (named.has(key)) continue;
    unnamedByBucket.set(location.bucket, [...(unnamedByBucket.get(location.bucket) ?? []), location.filePath]);
  }

  for (const [bucket, paths] of unnamedByBucket) {
    try {
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) throw error;
    } catch (error) {
      logBackendError('failed_to_remove_unrecorded_generation_outputs', { generationId, bucket, paths, error });
    }
  }
}

/**
 * Stamps the display rendition on the settled row, conditioned on the original
 * it was built from, then removes what the run uploaded that the row does not
 * name. A failed stamp is logged and removes nothing: it may have landed, and
 * a display has a fallback (every reader serves the source without one).
 */
export async function recordGenerationDisplayRendition(
  supabase: SupabaseClient,
  {
    generationId,
    predictionId,
    ownerUserId,
    outputPath,
    displayUrl,
    uploaded,
  }: {
    generationId: string;
    predictionId: string | null;
    ownerUserId: string;
    outputPath: string;
    displayUrl: string;
    uploaded: ReadonlyArray<string | null | undefined>;
  },
): Promise<void> {
  let data: unknown = null;
  let error: unknown = null;
  try {
    ({ data, error } = await supabase
      .from('generations')
      .update({ display_url: displayUrl })
      .eq('id', generationId)
      .eq('output_url', outputPath)
      .select(GENERATION_OUTPUT_NAMING_COLUMNS));
  } catch (thrown) {
    error = thrown;
  }
  if (error) {
    logBackendWarning('generation_display_rendition_not_recorded', { predictionId, error });
    return;
  }

  const [row] = Array.isArray(data) ? data as GenerationNamingRow[] : [];
  // No row matched: the run was deleted, or now serves another original. The
  // row is read back, so whatever it does name stays.
  await removeUnrecordedGenerationOutputs(supabase, { generationId, ownerUserId, uploaded, row });
}
