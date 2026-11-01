import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import {
  getCanonicalGenerationShowcaseAssetPath,
  removeGenerationShowcaseDerivative,
  SHOWCASE_MEDIA_BUCKET,
} from '@/lib/generation-post-media';
import { POST_MEDIA_PATH_COLUMNS, type PostMediaPathColumn } from '@/lib/post-media-storage';

/**
 * Retries for public showcase derivatives that a post stopped needing.
 *
 * The public bucket serves whatever is in it, so a copy stays fetchable until
 * its object is gone. The posts trigger `posts_sync_generation_exposure`
 * queues a derivative in the post write's own transaction whenever an
 * unexposed post drops it or a post is deleted outright,
 * `posts_queue_deleted_post_media` queues what a deleted post's media rows
 * named beside it before the delete cascades to them, and the media sweeps
 * queue what they uploaded when their row update then matched no row
 * (`queueUnrecordedShowcaseMedia`). The routes still delete
 * the copy inline; this drains what they missed, so a failed or skipped delete
 * can no longer leave a private post's media public.
 */

export const SHOWCASE_MEDIA_REVOCATION_BATCH_LIMIT = 50;
export const SHOWCASE_MEDIA_REVOCATION_RETRY_BASE_MS = 10 * 60 * 1000;
export const SHOWCASE_MEDIA_REVOCATION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * A copy still queued a day after its post stopped exposing it fails the run,
 * which raises JOB_LATEST_RUN_FAILED. By then it is not a transient storage
 * error, and the copy is still publicly fetchable.
 */
export const SHOWCASE_MEDIA_REVOCATION_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

const REVOCATIONS_TABLE = 'showcase_media_revocations';

type RevocationRow = {
  id: string;
  generation_id: string;
  post_id: string | null;
  showcase_asset_path: string;
  attempt_count: number | null;
};

type GenerationRow = {
  showcase_asset_path: string | null;
};

type CreationPostRow = {
  id: string;
  visibility: string | null;
  tombstoned_at: string | null;
  showcase_asset_path: string | null;
  post_media: Array<Record<PostMediaPathColumn | SweepLeaseColumn, string | null>> | null;
};

/**
 * The sweeps lease a row for five minutes (media-preview-repair's
 * p_lock_ttl_seconds, the teaser claim's 300 s) and upload only while they
 * hold it. A lease older than that belongs to a worker that is gone.
 */
const MEDIA_SWEEP_LEASE_MS = 5 * 60 * 1000;
const SWEEP_LEASE_COLUMNS = ['preview_locked_at', 'rendition_locked_at', 'teaser_locked_at'] as const;
type SweepLeaseColumn = (typeof SWEEP_LEASE_COLUMNS)[number];

const CREATION_POST_COLUMNS = `id, visibility, tombstoned_at, showcase_asset_path, post_media(${
  [...POST_MEDIA_PATH_COLUMNS, ...SWEEP_LEASE_COLUMNS].join(', ')
})`;

type RevocationOutcome =
  | { settled: true; reason: 'removed' | 'stillServing' | 'outsidePrefix' }
  | { settled: false; error: string };

export type ShowcaseMediaRevocationSummary = {
  due: number;
  removed: number;
  stillServing: number;
  outsidePrefix: number;
  rescheduled: number;
  stuck: number;
};

export class ShowcaseMediaRevocationsStuckError extends Error {
  summary: ShowcaseMediaRevocationSummary;

  constructor(summary: ShowcaseMediaRevocationSummary) {
    super(
      `${summary.stuck} public showcase ${summary.stuck === 1 ? 'copy is' : 'copies are'} still queued for revocation a day after the post stopped exposing it.`,
    );
    this.name = 'ShowcaseMediaRevocationsStuckError';
    this.summary = summary;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export function showcaseMediaRevocationRetryDelayMs(attempt: number): number {
  return Math.min(
    SHOWCASE_MEDIA_REVOCATION_RETRY_MAX_MS,
    SHOWCASE_MEDIA_REVOCATION_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
}

/**
 * Any queued row, due or not: a row waiting out its backoff can still be old
 * enough to fail the run, and that must not hide behind a "no work" skip.
 */
export async function hasPendingShowcaseMediaRevocations(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.from(REVOCATIONS_TABLE).select('id').limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function revoke(
  client: SupabaseClient,
  row: RevocationRow,
  removeDerivative: typeof removeGenerationShowcaseDerivative,
  now: Date,
): Promise<RevocationOutcome> {
  const path = getCanonicalGenerationShowcaseAssetPath(row.showcase_asset_path, row.generation_id);
  if (!path) {
    // The trigger queues raw column values. Only an object under the
    // generation's own prefix is ever removed; anything else is left alone.
    logBackendWarning('showcase_media_revocation_outside_generation_prefix', {
      revocationId: row.id,
      generationId: row.generation_id,
    });
    return { settled: true, reason: 'outsidePrefix' };
  }

  const [generation, creationPosts] = await Promise.all([
    client
      .from('generations')
      .select('showcase_asset_path')
      .eq('id', row.generation_id)
      .maybeSingle(),
    // The creation's post as it is now, linked or recording the creation as
    // deleted (generation_id is unique), with its media rows. The queue keeps
    // one row per object, under the first post that queued it: that post may
    // be gone, and the creation published again at once gets the same
    // content-addressed names.
    client
      .from('posts')
      .select(CREATION_POST_COLUMNS)
      .or(`generation_id.eq.${row.generation_id},deleted_generation_id.eq.${row.generation_id}`),
  ]);
  if (generation.error) return { settled: false, error: errorText(generation.error) };
  if (creationPosts.error) return { settled: false, error: errorText(creationPosts.error) };

  const generationRow = generation.data as GenerationRow | null;
  const posts = (creationPosts.data ?? []) as unknown as CreationPostRow[];
  // A private post serves nothing public, so its leftover media rows go with
  // the copy. A tombstoned one keeps its media for its buyers while it still
  // names its copy; one made private before its tombstone had dropped it.
  const servingPosts = posts.filter((post) => (
    post.visibility !== 'private' || Boolean(post.tombstoned_at && post.showcase_asset_path)
  ));
  const privatePost = posts.find((post) => !servingPosts.includes(post));
  // Named since it was queued, as the creation's or a post's copy or by a
  // serving post's media row: it is serving.
  const stillServing = [
    generationRow?.showcase_asset_path,
    ...posts.map((post) => post.showcase_asset_path),
    ...servingPosts
      .flatMap((post) => post.post_media ?? [])
      .flatMap((media) => POST_MEDIA_PATH_COLUMNS.map((column) => media[column])),
  ].some((candidate) => getCanonicalGenerationShowcaseAssetPath(candidate, row.generation_id) === path);
  if (stillServing) {
    return { settled: true, reason: 'stillServing' };
  }

  // A sweep uploads a derivative before its row names it. While one holds a
  // serving post's row, the name it is about to record may be this one.
  const leasedSince = now.getTime() - MEDIA_SWEEP_LEASE_MS;
  const buildingMedia = servingPosts
    .flatMap((post) => post.post_media ?? [])
    .some((media) => SWEEP_LEASE_COLUMNS.some((column) => {
      const lockedAt = media[column];
      return lockedAt !== null && Date.parse(lockedAt) > leasedSince;
    }));
  if (buildingMedia) {
    return { settled: false, error: 'A post of the creation is still building its media.' };
  }

  const removal = await removeDerivative({
    adminSupabase: client,
    generationId: row.generation_id,
    showcaseAssetPath: path,
    postId: privatePost?.id ?? null,
  });
  if (removal.error) {
    return { settled: false, error: removal.error.message ?? 'Storage removal failed.' };
  }

  const verification = await client.storage.from(SHOWCASE_MEDIA_BUCKET).exists(path);
  if (verification.data === true) {
    return { settled: false, error: 'The object still exists after removal.' };
  }

  return { settled: true, reason: 'removed' };
}

export async function processShowcaseMediaRevocations(
  client: SupabaseClient,
  {
    now,
    limit = SHOWCASE_MEDIA_REVOCATION_BATCH_LIMIT,
    removeDerivative = removeGenerationShowcaseDerivative,
  }: {
    now: Date;
    limit?: number;
    removeDerivative?: typeof removeGenerationShowcaseDerivative;
  },
): Promise<ShowcaseMediaRevocationSummary> {
  const { data, error } = await client
    .from(REVOCATIONS_TABLE)
    .select('id, generation_id, post_id, showcase_asset_path, attempt_count')
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as RevocationRow[];
  const summary: ShowcaseMediaRevocationSummary = {
    due: rows.length,
    removed: 0,
    stillServing: 0,
    outsidePrefix: 0,
    rescheduled: 0,
    stuck: 0,
  };

  for (const row of rows) {
    let outcome: RevocationOutcome;
    try {
      outcome = await revoke(client, row, removeDerivative, now);
    } catch (revokeError) {
      outcome = { settled: false, error: errorText(revokeError) };
    }

    if (outcome.settled) {
      const { error: deleteError } = await client.from(REVOCATIONS_TABLE).delete().eq('id', row.id);
      if (deleteError) throw deleteError;
      summary[outcome.reason] += 1;
      continue;
    }

    const attempt = (row.attempt_count ?? 0) + 1;
    const { error: rescheduleError } = await client
      .from(REVOCATIONS_TABLE)
      .update({
        attempt_count: attempt,
        next_attempt_at: new Date(now.getTime() + showcaseMediaRevocationRetryDelayMs(attempt)).toISOString(),
        last_error: outcome.error.slice(0, 1000),
      })
      .eq('id', row.id);
    if (rescheduleError) throw rescheduleError;
    summary.rescheduled += 1;
  }

  const { count, error: stuckError } = await client
    .from(REVOCATIONS_TABLE)
    .select('id', { count: 'exact', head: true })
    .lt('created_at', new Date(now.getTime() - SHOWCASE_MEDIA_REVOCATION_STUCK_AFTER_MS).toISOString());
  if (stuckError) throw stuckError;
  summary.stuck = count ?? 0;

  if (summary.stuck > 0) {
    throw new ShowcaseMediaRevocationsStuckError(summary);
  }

  return summary;
}
