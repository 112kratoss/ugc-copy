import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { createGenerationOutputPreview } from '@/lib/generation-output-preview';
import { createVideoPosterBuffer } from '@/lib/video-poster';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createPostMediaRendition, type PostMediaTeaserOutcome } from '@/lib/post-media-rendition';
import type { VideoProbeResult } from '@/lib/video-rendition';
import {
  fetchWithProviderRetry,
  PROVIDER_MEDIA_DOWNLOAD_RETRY_POLICY,
  PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import {
  getCanonicalStoredMediaLocation,
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';
import { toStorageUploadBody } from '@/lib/storage-upload-body';

const MAX_PREVIEW_ATTEMPTS = 3;
export const MAX_RENDITION_ATTEMPTS = 3;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
/**
 * Transcoding is far heavier than a poster frame. The repair has a dedicated
 * invocation, but renditions still take a small bite and run one at a time so
 * one sweep remains bounded. Backfill may span several hourly runs.
 *
 * The bite used to be a flat five rows. That capped recovery at five videos an
 * hour however short they were, and — because each transcode may run for the
 * full 120s ffmpeg timeout — it did not actually bound anything: five rows
 * could occupy 600s of a 300s invocation. The wall clock below is the real
 * limit now, and the count is only a ceiling on how many rows to fetch.
 *
 * Still deliberately sequential. Concurrent ffmpeg would contend for the same
 * one or two cores and increase peak memory. Isolation removed the historical
 * shared-fate cron risk; concurrency should only change with measured worker
 * headroom.
 */
export const RENDITION_REPAIR_BATCH_SIZE = 12;
/**
 * Checked before starting each row, so the true worst case is this plus one
 * full ffmpeg timeout. At 60s that keeps the dedicated invocation comfortably
 * below its platform duration limit in the normal case.
 */
export const RENDITION_REPAIR_TIME_BUDGET_MS = 60_000;

/**
 * Bytes of source video a single sweep will admit (F14).
 *
 * 256 MB is roughly one 250 MB worst-case object, or a couple of dozen typical
 * feed clips at the measured ~7.6 MB average. The wall clock still bounds the
 * run; this bounds what gets *committed to* before the clock starts, which is
 * the decision the old count-only claim could not make. The queue head is
 * always admitted regardless, so a single oversized object cannot wedge the
 * sweep permanently.
 */
export const RENDITION_REPAIR_BYTE_BUDGET = 256 * 1024 * 1024;
const UNRESOLVED_STATUSES = ['pending', 'processing', 'failed'] as const;

type RepairSummary = {
  attempted: number;
  completed: number;
  failed: number;
};

type GenerationRepairRow = {
  id: string;
  user_id?: string;
  output_url: string;
  category: string | null;
  preview_attempt_count: number | null;
};

type PostMediaRepairRow = {
  id: string;
  post_id?: string;
  storage_path: string;
  media_kind: 'image' | 'video';
  content_type: string | null;
  preview_attempt_count: number | null;
};

type PostMediaRenditionRepairRow = {
  id: string;
  post_id?: string;
  storage_path: string;
  content_type: string | null;
  rendition_attempt_count: number | null;
  /**
   * Absent (not just null) when the claim came from a pre-teaser RPC or a
   * database without the teaser columns — the worker gates all teaser work on
   * field presence so it never writes a column that might not exist.
   */
  teaser_storage_path?: string | null;
  duration_seconds?: number | null;
};

type ClaimedRows<T> = { rows: T[]; leased: boolean };

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

/**
 * Deliberately distinct from the rendition matcher: missing teaser columns
 * only degrade the sweep to teasers-off (retry the claim without them), while
 * missing rendition columns disable rendition work entirely. Folding the two
 * into one regex would turn "teaser migration not applied yet" into "stop all
 * rendition repair", which is exactly backwards.
 */
export function isMissingTeaserColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as { code?: string; message?: string };
  return (code === '42703' || code === 'PGRST204') && /teaser_/.test(message);
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

  if (await hasRepairableTemplateDemoPosters(supabase)) return true;

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

const GENERATION_MEDIA_BUCKETS = [
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
] as const;

async function resolveGenerationRepairSource(
  supabase: SupabaseClient,
  row: GenerationRepairRow,
): Promise<{ outputUrl: string; ownerUserId: string }> {
  if (typeof row.user_id === 'string' && row.user_id.length > 0) {
    return { outputUrl: row.output_url, ownerUserId: row.user_id };
  }

  // Older claim RPCs do not return user_id. Reload the current row through the
  // service client so the object path is bound to the durable owner before a
  // privileged download.
  const { data, error } = await supabase
    .from('generations')
    .select('user_id, output_url')
    .eq('id', row.id)
    .maybeSingle();
  const current = data as { user_id?: unknown; output_url?: unknown } | null;
  if (
    error
    || !current
    || typeof current.user_id !== 'string'
    || current.user_id.length === 0
    || typeof current.output_url !== 'string'
    || current.output_url.length === 0
  ) {
    throw error ?? new Error('Generation repair source could not be owner-scoped.');
  }
  return { outputUrl: current.output_url, ownerUserId: current.user_id };
}

function getCanonicalPostMediaPath(storagePath: string, postId: string): string | null {
  if (!postId) return null;
  const canonicalPath = parseCanonicalStorageObjectPath(storagePath, { minimumSegments: 3 });
  if (!canonicalPath) return null;
  const [namespace, scopedPostId] = canonicalPath.split('/');
  return namespace === 'posts' && scopedPostId === postId ? canonicalPath : null;
}

async function resolvePostMediaRepairPath(
  supabase: SupabaseClient,
  row: Pick<PostMediaRepairRow, 'id' | 'post_id' | 'storage_path'>,
): Promise<string> {
  let postId = row.post_id;
  let storagePath = row.storage_path;
  if (typeof postId !== 'string' || postId.length === 0) {
    // Older claim RPCs omit post_id. Reload both values together so a stale or
    // attacker-controlled path cannot be paired with an inferred scope.
    const { data, error } = await supabase
      .from('post_media')
      .select('post_id, storage_path')
      .eq('id', row.id)
      .maybeSingle();
    const current = data as { post_id?: unknown; storage_path?: unknown } | null;
    if (
      error
      || !current
      || typeof current.post_id !== 'string'
      || current.post_id.length === 0
      || typeof current.storage_path !== 'string'
      || current.storage_path.length === 0
    ) {
      throw error ?? new Error('Post media repair source could not be post-scoped.');
    }
    postId = current.post_id;
    storagePath = current.storage_path;
  }

  const canonicalPath = getCanonicalPostMediaPath(storagePath, postId);
  if (!canonicalPath) throw new Error('Post media repair source is outside the owning post prefix.');
  return canonicalPath;
}

async function downloadMedia(
  supabase: SupabaseClient,
  source: string,
  ownerUserId: string,
): Promise<Blob> {
  const location = getUserOwnedStoredMediaLocation(source, ownerUserId, {
    allowedBuckets: GENERATION_MEDIA_BUCKETS,
  });
  if (location) {
    const result = await supabase.storage.from(location.bucket).download(location.filePath);
    if (result.error || !result.data) throw result.error ?? new Error('Stored media could not be downloaded.');
    return result.data;
  }

  if (getCanonicalStoredMediaLocation(source, { allowedBuckets: GENERATION_MEDIA_BUCKETS })) {
    throw new Error('Stored media is outside the generation owner prefix.');
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

async function repairGeneration(
  supabase: SupabaseClient,
  row: GenerationRepairRow,
  leaseOwner?: string,
): Promise<boolean> {
  const attempts = row.preview_attempt_count ?? 0;
  try {
    if (!leaseOwner) {
      await supabase.from('generations').update({ preview_status: 'processing' }).eq('id', row.id);
    }
    const source = await resolveGenerationRepairSource(supabase, row);
    const body = await downloadMedia(supabase, source.outputUrl, source.ownerUserId);
    const preview = await createGenerationOutputPreview({
      body,
      category: row.category,
      contentType: body.type,
      storagePath: source.outputUrl,
      supabase,
    });
    if (!preview) throw new Error('Media type does not support a visual preview.');

    let resultQuery = supabase.from('generations').update({
      preview_url: preview.previewStoragePath,
      preview_thumbhash: preview.previewThumbhash,
      preview_status: 'ready',
      preview_attempt_count: attempts + 1,
      preview_error: null,
      preview_generated_at: new Date().toISOString(),
      preview_locked_at: null,
      preview_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) resultQuery = resultQuery.eq('preview_locked_by', leaseOwner);
    const result = await resultQuery;
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    const failure = supabase.from('generations').update({
      ...previewFailure(error, attempts),
      preview_locked_at: null,
      preview_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) failure.eq('preview_locked_by', leaseOwner);
    await failure;
    return false;
  }
}

async function repairPostMedia(
  supabase: SupabaseClient,
  row: PostMediaRepairRow,
  leaseOwner?: string,
): Promise<boolean> {
  const attempts = row.preview_attempt_count ?? 0;
  try {
    if (!leaseOwner) {
      await supabase.from('post_media').update({ preview_status: 'processing' }).eq('id', row.id);
    }
    const storagePath = await resolvePostMediaRepairPath(supabase, row);
    const download = await supabase.storage.from(SHOWCASE_MEDIA_BUCKET).download(storagePath);
    if (download.error || !download.data) {
      throw download.error ?? new Error('Stored post media could not be downloaded.');
    }

    const body = download.data;
    const preview = await createPostMediaPreview({
      body,
      contentType: row.content_type || body.type,
      storagePath,
      supabase,
    });
    if (!preview) throw new Error('Media type does not support a visual preview.');

    let resultQuery = supabase.from('post_media').update({
      preview_storage_path: preview.previewStoragePath,
      preview_thumbhash: preview.previewThumbhash,
      preview_status: 'ready',
      preview_attempt_count: attempts + 1,
      preview_error: null,
      preview_generated_at: new Date().toISOString(),
      width: preview.width,
      height: preview.height,
      preview_locked_at: null,
      preview_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) resultQuery = resultQuery.eq('preview_locked_by', leaseOwner);
    const result = await resultQuery;
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    const failure = supabase.from('post_media').update({
      ...previewFailure(error, attempts),
      preview_locked_at: null,
      preview_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) failure.eq('preview_locked_by', leaseOwner);
    await failure;
    return false;
  }
}

async function repairPostMediaRendition(
  supabase: SupabaseClient,
  row: PostMediaRenditionRepairRow,
  leaseOwner?: string,
): Promise<boolean> {
  const attempts = row.rendition_attempt_count ?? 0;
  // Field presence, not value: a pre-teaser claim RPC or database returns rows
  // without the field at all, and then no update may reference the columns.
  const teaserColumnsPresent = 'teaser_storage_path' in row;
  let inputProbe: VideoProbeResult | null = null;
  let teaserOutcome: PostMediaTeaserOutcome | null = null;
  // The probe and the teaser both precede the full transcode, so their results
  // must survive every exit below — including the throw path.
  const midFlightSpread = () => ({
    ...(inputProbe?.durationSeconds != null ? { duration_seconds: inputProbe.durationSeconds } : {}),
    ...(teaserOutcome?.status === 'ready'
      ? {
        teaser_storage_path: teaserOutcome.teaserStoragePath,
        teaser_bytes: teaserOutcome.teaserBytes,
        teaser_generated_at: new Date().toISOString(),
        teaser_error: null,
      }
      : {}),
    ...(teaserOutcome?.status === 'failed'
      ? { teaser_error: teaserOutcome.error.slice(0, 500) }
      : {}),
  });
  try {
    if (!leaseOwner) {
      await supabase.from('post_media').update({ rendition_status: 'processing' }).eq('id', row.id);
    }
    const storagePath = await resolvePostMediaRepairPath(supabase, row);
    const download = await supabase.storage.from(SHOWCASE_MEDIA_BUCKET).download(storagePath);
    if (download.error || !download.data) {
      throw download.error ?? new Error('Stored post media could not be downloaded.');
    }

    const body = download.data;
    const rendition = await createPostMediaRendition({
      body,
      contentType: row.content_type || body.type,
      storagePath,
      supabase,
      // Content-hashed teasers never go stale, so an existing one is final. A
      // truthy sentinel also stands in when the columns are unavailable —
      // teaser work without a recordable outcome would be wasted encode time.
      existingTeaserPath: teaserColumnsPresent
        ? row.teaser_storage_path ?? null
        : 'teaser-columns-unavailable',
      onInputProbe: (probe) => { inputProbe = probe; },
      ...(teaserColumnsPresent
        ? { onTeaserOutcome: (outcome: PostMediaTeaserOutcome) => { teaserOutcome = outcome; } }
        : {}),
    });

    // 'skipped' is a correct terminal answer, not a failure — record it so the
    // row stops appearing in this sweep.
    if (rendition.status === 'skipped') {
      let skipQuery = supabase.from('post_media').update({
        rendition_status: 'skipped',
        rendition_attempt_count: attempts + 1,
        rendition_error: `Rendition skipped: ${rendition.reason}.`,
        ...midFlightSpread(),
        rendition_locked_at: null,
        rendition_locked_by: null,
      }).eq('id', row.id);
      if (leaseOwner) skipQuery = skipQuery.eq('rendition_locked_by', leaseOwner);
      const skipResult = await skipQuery;
      if (skipResult.error) throw skipResult.error;
      return true;
    }

    let resultQuery = supabase.from('post_media').update({
      rendition_storage_path: rendition.renditionStoragePath,
      rendition_status: 'ready',
      rendition_attempt_count: attempts + 1,
      rendition_error: null,
      rendition_generated_at: new Date().toISOString(),
      rendition_bytes: rendition.renditionBytes,
      // Backfill the dimensions and duration the original publish never captured.
      ...(rendition.width === null ? {} : { width: rendition.width }),
      ...(rendition.height === null ? {} : { height: rendition.height }),
      ...midFlightSpread(),
      // The output probe wins over the input probe when both landed.
      ...(rendition.durationSeconds === null ? {} : { duration_seconds: rendition.durationSeconds }),
      rendition_locked_at: null,
      rendition_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) resultQuery = resultQuery.eq('rendition_locked_by', leaseOwner);
    const result = await resultQuery;
    if (result.error) throw result.error;
    return true;
  } catch (error) {
    const failure = supabase.from('post_media').update({
      rendition_status: 'failed',
      rendition_attempt_count: Math.min(MAX_RENDITION_ATTEMPTS, attempts + 1),
      rendition_error: error instanceof Error ? error.message.slice(0, 500) : 'Rendition generation failed.',
      // The whole point of teaser-first: a timeout here must not lose the
      // teaser that already uploaded, nor the probed duration.
      ...midFlightSpread(),
      rendition_locked_at: null,
      rendition_locked_by: null,
    }).eq('id', row.id);
    if (leaseOwner) failure.eq('rendition_locked_by', leaseOwner);
    await failure;
    return false;
  }
}

function isMissingRenditionAdmissionRpcError(error: { message?: string } | null): boolean {
  const message = error?.message ?? '';
  return message.includes('claim_media_rendition_repairs')
    || message.includes('list_media_rendition_repair_candidates')
    || message.includes('schema cache');
}

/**
 * Claim rendition work bounded by bytes, not just row count (F14).
 *
 * Twelve short clips and twelve 30 MB clips looked identical to the old
 * count-only claim. The wall clock added by F2 stops the invocation
 * overrunning, but only after the bytes are already committed to -- it aborts
 * mid-batch rather than declining to admit the work. Falls back to the previous
 * count-only query on a database that has not applied the migration.
 */
async function claimRenditionRepairRows(
  supabase: SupabaseClient,
  batchSize: number,
  byteBudget: number,
  lockedBy: string,
): Promise<ClaimedRows<PostMediaRenditionRepairRow> | null> {
  const claimed = await supabase.rpc('claim_media_rendition_repairs', {
    p_limit: batchSize,
    p_byte_budget: byteBudget,
    p_locked_by: lockedBy,
    p_lock_ttl_seconds: 300,
    p_max_attempts: MAX_RENDITION_ATTEMPTS,
  });

  if (!claimed.error) {
    return { rows: (claimed.data ?? []) as PostMediaRenditionRepairRow[], leased: true };
  }

  if (!isMissingRenditionAdmissionRpcError(claimed.error)) {
    if (isMissingRenditionColumnError(claimed.error)) return null;
    throw claimed.error;
  }

  // Two-tier, mirroring the degrade ladder in post-media.ts: first ask with
  // the teaser columns, and on a database that has not applied that migration
  // retry without them — the rows then lack the field entirely, which is what
  // switches the worker's teaser step off.
  const selectRenditionRows = (columns: string) => supabase
    .from('post_media')
    .select(columns)
    .eq('media_kind', 'video')
    .in('rendition_status', UNRESOLVED_STATUSES)
    .lt('rendition_attempt_count', MAX_RENDITION_ATTEMPTS)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  let { data, error } = await selectRenditionRows(
    'id, post_id, storage_path, content_type, rendition_attempt_count, teaser_storage_path, duration_seconds',
  );
  if (error && isMissingTeaserColumnError(error)) {
    ({ data, error } = await selectRenditionRows('id, post_id, storage_path, content_type, rendition_attempt_count'));
  }

  if (error) {
    if (isMissingRenditionColumnError(error)) return null;
    throw error;
  }

  return { rows: (data ?? []) as unknown as PostMediaRenditionRepairRow[], leased: false };
}

export async function repairPostMediaRenditions(
  supabase: SupabaseClient,
  options: {
    batchSize?: number;
    timeBudgetMs?: number;
    byteBudget?: number;
    lockedBy?: string;
  } = {},
): Promise<RepairSummary> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? RENDITION_REPAIR_BATCH_SIZE, 50));
  const timeBudgetMs = Math.max(0, options.timeBudgetMs ?? RENDITION_REPAIR_TIME_BUDGET_MS);
  const byteBudget = Math.max(1, options.byteBudget ?? RENDITION_REPAIR_BYTE_BUDGET);

  const lockedBy = options.lockedBy ?? `media-rendition:${randomUUID()}`;
  const claimed = await claimRenditionRepairRows(supabase, batchSize, byteBudget, lockedBy);
  if (claimed === null) {
    return { attempted: 0, completed: 0, failed: 0 };
  }

  const rows = claimed.rows.filter((row) => canRepairRendition(row.rendition_attempt_count));

  // Sequential on purpose: concurrent ffmpeg processes would contend for the
  // same one or two cores and push the job past its duration budget.
  //
  // Stopping on elapsed time rather than a row count is what actually protects
  // the invocation budget, since one 30 MB clip can cost as much as ten short
  // ones. The first row always runs: otherwise a queue whose head is slow would
  // never drain, and rows are taken oldest-first.
  const startedAt = Date.now();
  let attempted = 0;
  let completed = 0;
  for (const row of rows) {
    if (attempted > 0 && Date.now() - startedAt >= timeBudgetMs) {
      break;
    }

    attempted += 1;
    if (await repairPostMediaRendition(supabase, row, claimed.leased ? lockedBy : undefined)) {
      completed += 1;
    }
  }

  return { attempted, completed, failed: attempted - completed };
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
    .select('id, post_id, storage_path, media_kind, content_type, preview_attempt_count')
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
    .select('id, post_id, storage_path, content_type, rendition_attempt_count')
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

function isMissingPreviewClaimRpc(error: { message?: string } | null): boolean {
  const message = error?.message ?? '';
  return message.includes('claim_generation_preview_repairs')
    || message.includes('claim_post_media_preview_repairs')
    || message.includes('list_media_rendition_repair_candidates')
    || message.includes('schema cache');
}

async function claimGenerationPreviewRows(
  supabase: SupabaseClient,
  limit: number,
  lockedBy: string,
): Promise<ClaimedRows<GenerationRepairRow>> {
  const claimed = await supabase.rpc('claim_generation_preview_repairs', {
    p_limit: limit,
    p_locked_by: lockedBy,
    p_lock_ttl_seconds: 300,
    p_max_attempts: MAX_PREVIEW_ATTEMPTS,
  });
  if (!claimed.error) {
    return { rows: (claimed.data ?? []) as GenerationRepairRow[], leased: true };
  }
  if (!isMissingPreviewClaimRpc(claimed.error)) throw claimed.error;

  const fallback = await supabase
    .from('generations')
    .select('id, user_id, output_url, category, preview_attempt_count')
    .eq('status', 'succeeded')
    .in('category', ['image', 'video'])
    .in('preview_status', ['pending', 'failed', 'processing'])
    .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
    .not('output_url', 'is', null)
    .order('completed_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (fallback.error) throw fallback.error;
  return { rows: (fallback.data ?? []) as GenerationRepairRow[], leased: false };
}

async function claimPostMediaPreviewRows(
  supabase: SupabaseClient,
  limit: number,
  lockedBy: string,
): Promise<ClaimedRows<PostMediaRepairRow>> {
  const claimed = await supabase.rpc('claim_post_media_preview_repairs', {
    p_limit: limit,
    p_locked_by: lockedBy,
    p_lock_ttl_seconds: 300,
    p_max_attempts: MAX_PREVIEW_ATTEMPTS,
  });
  if (!claimed.error) {
    return { rows: (claimed.data ?? []) as PostMediaRepairRow[], leased: true };
  }
  if (!isMissingPreviewClaimRpc(claimed.error)) throw claimed.error;

  const fallback = await supabase
    .from('post_media')
    .select('id, post_id, storage_path, media_kind, content_type, preview_attempt_count')
    .in('preview_status', ['pending', 'failed', 'processing'])
    .lt('preview_attempt_count', MAX_PREVIEW_ATTEMPTS)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (fallback.error) throw fallback.error;
  return { rows: (fallback.data ?? []) as PostMediaRepairRow[], leased: false };
}

async function mapWithConcurrency<T>(
  rows: T[],
  concurrency: number,
  worker: (row: T) => Promise<boolean>,
): Promise<boolean[]> {
  const output = new Array<boolean>(rows.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, rows.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= rows.length) return;
        output[index] = await worker(rows[index]!);
      }
    },
  ));
  return output;
}

/**
 * Small on purpose: the steady state is publish-time extraction in
 * `publishMediaTemplate`, so this sweep only backfills templates published
 * before posters existed and heals the rare extraction failure. Posters are
 * bounded (2× the 30s ffmpeg poster timeout each), and the poster upload is
 * an upsert so a retry after a failed row update is harmless.
 */
export const TEMPLATE_POSTER_BATCH_SIZE = 3;

export async function hasRepairableTemplateDemoPosters(supabase: SupabaseClient): Promise<boolean> {
  const result = await supabase
    .from('templates')
    .select('id')
    .eq('status', 'active')
    .eq('is_active', true)
    .eq('output_kind', 'video')
    .is('thumbnail_url', null)
    .like('video_url', 'template_assets/%')
    .limit(1);
  if (result.error) throw result.error;
  return hasRows(result.data);
}

export async function repairTemplateDemoPosters(
  supabase: SupabaseClient,
  options: { batchSize?: number } = {}
): Promise<RepairSummary> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? TEMPLATE_POSTER_BATCH_SIZE, 10));
  const { data, error } = await supabase
    .from('templates')
    .select('id, video_url')
    .eq('status', 'active')
    .eq('is_active', true)
    .eq('output_kind', 'video')
    .is('thumbnail_url', null)
    .like('video_url', 'template_assets/%')
    .limit(batchSize);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; video_url: string }>;
  let completed = 0;
  for (const row of rows) {
    try {
      const demoLocation = parseCanonicalStorageLocation(row.video_url, {
        allowedBuckets: ['template_assets'],
      });
      if (!demoLocation) throw new Error('Template demo path is not canonical.');
      const demoSegments = demoLocation.filePath.split('/');
      if (
        demoSegments.length < 4
        || demoSegments[0] !== row.id
        || demoSegments[2] !== 'demo'
      ) {
        throw new Error('Template demo path is outside the template version scope.');
      }
      const demoObjectPath = demoLocation.filePath;
      const demoDirectory = demoSegments.slice(0, -1).join('/');
      const download = await supabase.storage.from('template_assets').download(demoObjectPath);
      if (download.error || !download.data) {
        throw download.error ?? new Error('Template demo could not be downloaded.');
      }
      const poster = await createVideoPosterBuffer(download.data);
      const posterObjectPath = `${demoDirectory}/poster.webp`;
      const upload = await supabase.storage.from('template_assets')
        .upload(posterObjectPath, toStorageUploadBody(poster, 'image/webp'), { contentType: 'image/webp', upsert: true });
      if (upload.error) throw upload.error;
      const update = await supabase.from('templates')
        .update({ thumbnail_url: `template_assets/${posterObjectPath}` })
        .eq('id', row.id)
        .is('thumbnail_url', null);
      if (update.error) throw update.error;
      completed += 1;
    } catch (repairError) {
      // Templates carry no attempt counter; the bounded batch plus upsert
      // keeps hourly retries of a stubborn row cheap and harmless.
      logBackendError('failed_to_repair_template_demo_poster', { templateId: row.id, error: repairError });
    }
  }
  return { attempted: rows.length, completed, failed: rows.length - completed };
}

export async function repairMediaPreviews(
  supabase: SupabaseClient,
  options: {
    batchSize?: number;
    renditionBatchSize?: number;
    invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
    lockedBy?: string;
  } = {}
): Promise<RepairSummary> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 500));
  const lockedBy = options.lockedBy ?? `media-preview:${randomUUID()}`;
  const [generations, postMedia] = await Promise.all([
    claimGenerationPreviewRows(supabase, batchSize, `${lockedBy}:generation`),
    claimPostMediaPreviewRows(supabase, batchSize, `${lockedBy}:post`),
  ]);
  const repairRows = [
    ...generations.rows
      .filter((row) => canRepairPreview(row.preview_attempt_count))
      .map((row) => ({
        row,
        worker: () => repairGeneration(
          supabase,
          row,
          generations.leased ? `${lockedBy}:generation` : undefined,
        ),
      })),
    ...postMedia.rows
      .filter((row) => canRepairPreview(row.preview_attempt_count))
      .map((row) => ({
        row,
        worker: () => repairPostMedia(
          supabase,
          row,
          postMedia.leased ? `${lockedBy}:post` : undefined,
        ),
      })),
  ];
  // Four lightweight poster/image workers at most; rendition work below stays
  // strictly single-file so ffmpeg and temporary disk cannot fan out.
  const results = await mapWithConcurrency(repairRows, 4, (entry) => entry.worker());

  // Template demo posters are poster-frame work too, so they run with the
  // light pass — before renditions, which must never starve poster repair.
  const templatePosters = await repairTemplateDemoPosters(supabase);

  // Runs after the preview pass so poster frames — which the feed needs before
  // anything can play at all — always win the shared duration budget.
  const renditions = await repairPostMediaRenditions(supabase, {
    batchSize: options.renditionBatchSize,
    lockedBy: `${lockedBy}:rendition`,
  });

  const completed = results.filter(Boolean).length + templatePosters.completed + renditions.completed;
  const attempted = results.length + templatePosters.attempted + renditions.attempted;

  if (completed > 0) {
    (options.invalidateFeedCache ?? invalidateShowcaseFeedCache)();
  }

  return { attempted, completed, failed: attempted - completed };
}
