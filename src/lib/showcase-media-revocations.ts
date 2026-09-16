import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import {
  getCanonicalGenerationShowcaseAssetPath,
  removeGenerationShowcaseDerivative,
  SHOWCASE_MEDIA_BUCKET,
} from '@/lib/generation-post-media';

/**
 * Retries for public showcase derivatives that a post stopped needing.
 *
 * The public bucket serves whatever is in it, so a copy stays fetchable until
 * its object is gone. The posts trigger `posts_sync_generation_exposure`
 * queues a derivative in the post write's own transaction whenever an
 * unexposed post drops it or a post is deleted outright. The routes still
 * delete the copy inline; this drains what they missed, so a failed or skipped
 * delete can no longer leave a private post's media public.
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

type ExposureRow = {
  showcase_asset_path: string | null;
  visibility?: string | null;
};

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

  const [generation, post] = await Promise.all([
    client
      .from('generations')
      .select('showcase_asset_path')
      .eq('id', row.generation_id)
      .maybeSingle(),
    row.post_id
      ? client
        .from('posts')
        .select('visibility, showcase_asset_path')
        .eq('id', row.post_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (generation.error) return { settled: false, error: errorText(generation.error) };
  if (post.error) return { settled: false, error: errorText(post.error) };

  const generationRow = generation.data as ExposureRow | null;
  const postRow = post.data as ExposureRow | null;
  // Published again under the same path since it was queued: it is serving.
  const stillServing = [generationRow?.showcase_asset_path, postRow?.showcase_asset_path]
    .some((candidate) => getCanonicalGenerationShowcaseAssetPath(candidate, row.generation_id) === path);
  if (stillServing) {
    return { settled: true, reason: 'stillServing' };
  }

  const removal = await removeDerivative({
    adminSupabase: client,
    generationId: row.generation_id,
    showcaseAssetPath: path,
    // A private post's legacy media rows serve this same copy and go with it.
    // A post that is public again has a live cover row under this prefix.
    postId: postRow?.visibility === 'private' ? row.post_id : null,
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
      outcome = await revoke(client, row, removeDerivative);
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
