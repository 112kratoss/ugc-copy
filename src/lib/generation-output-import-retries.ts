import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo } from '@/lib/backend-logger';
import { GENERATION_OUTPUT_IMPORT_LOCK_TTL_SECONDS } from '@/lib/generation-output-import-jobs';
import { GenerationServiceError } from '@/lib/generation-service-core';
import { settleGenerationFailed } from '@/lib/generation-settlement';
import { notifyGenerationStatus, type GenerationNotificationSubject } from '@/lib/mobile-notifications';
import {
  classifyGenerationOutputImportError,
  GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS,
  GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES,
  generationOutputImportWindowEnded,
} from '@/lib/generation-output-import-window';

export {
  classifyGenerationOutputImportError,
  GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS,
  GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES,
  isGenerationOutputImportRetrying,
} from '@/lib/generation-output-import-window';

/**
 * What happens to a generation whose provider finished but whose file could
 * not be stored.
 *
 * The import queue (generation-output-import-jobs-processor.ts) tries ten times
 * with backoff, about an hour and three quarters, and then marks the job
 * `failed` ("exhausted"). Until 2026-11-27 nothing ended it: the generation
 * stayed `processing` with the credits taken, every status check reopened the
 * job for one more doomed attempt, and after an hour backend health went
 * degraded, which holds every production release.
 *
 * The owner's rule (2026-11-27): the creator gets the file whenever that is
 * still possible, and a refund when it is not. So an exhausted import is
 * reopened about once an hour, from this pass only (a repeated enqueue no
 * longer reopens it, migration 20261127060200), for as long as the provider's
 * file may still be there: a cause that gets fixed (a host added to
 * MEDIA_IMPORT_HOST_ALLOWLIST, a storage or provider outage that ends) still
 * delivers it. When the window ends the generation is failed and refunded
 * through `settle_generation_failed`, the same idempotent settlement an
 * exhausted completion job uses, and the creator gets the usual failure
 * notice. That settlement refunds at most once however the paths interleave:
 * it locks the row, refuses a generation that already succeeded and keeps
 * `refunded` once set, and an import that lands afterwards finds the row
 * failed and settles nothing.
 *
 * The window and its length are generation-output-import-window.ts.
 *
 * While the window is open the generation is excluded from backend health's
 * GENERATION_STALLED_ACTIVE (isGenerationOutputImportRetrying), and the
 * failing import is reported on /api/ops/backend-alerts instead
 * (generation-output-import-alert.ts), so this bounded state never freezes a
 * release but still reaches the owner.
 */

export const GENERATION_OUTPUT_IMPORT_RETRY_BATCH_LIMIT = 10;

export const GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE =
  'The render finished, but its file could not be saved before the provider removed it. Your credits have been refunded.';

const ACTIVE_GENERATION_STATUSES = ['waiting', 'processing'];
/**
 * Every state an import can be stuck in. A `failed` job is reopened hourly;
 * past its window, any of them ends: `pending` (never claimed in time) and
 * `processing` under a worker that died (its lease expired) included. A
 * crash loop also exhausts by itself, since each expired lease the claim
 * takes back counts as an attempt (migration 20261127060200).
 */
const UNFINISHED_IMPORT_STATUSES = ['failed', 'pending', 'processing'];
const HOUR_MS = 60 * 60 * 1000;

type ExhaustedImportRow = {
  id: string;
  status: 'failed' | 'pending' | 'processing';
  locked_at: string | null;
  generation_id: string;
  prediction_id: string;
  provider_completed_at: string | null;
  created_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  generations: GenerationNotificationSubject | GenerationNotificationSubject[] | null;
};

export type GenerationOutputImportRetrySummary = {
  eligible: number;
  reopened: number;
  /** Generations failed and refunded here: terminal transitions the run wakes waiting steps for. */
  abandoned: number;
  skipped: number;
  failed: number;
  deferred: number;
};

function cutoffs(nowMs: number) {
  return {
    retryBeforeIso: new Date(nowMs - GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES * 60 * 1000).toISOString(),
    giveUpBeforeIso: new Date(nowMs - GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS * HOUR_MS).toISOString(),
  };
}

function dueFilter(nowMs: number): string {
  const { retryBeforeIso, giveUpBeforeIso } = cutoffs(nowMs);
  return [
    `and(status.eq.failed,completed_at.lte.${retryBeforeIso})`,
    `created_at.lte.${giveUpBeforeIso}`,
    `provider_completed_at.lte.${giveUpBeforeIso}`,
  ].join(',');
}

function exhaustedImportsQuery(client: Pick<SupabaseClient, 'from'>, columns: string, nowMs: number) {
  return client
    .from('generation_output_import_jobs')
    .select(columns)
    .in('status', UNFINISHED_IMPORT_STATUSES)
    .in('generations.status', ACTIVE_GENERATION_STATUSES)
    .or(dueFilter(nowMs));
}

export async function hasDueGenerationOutputImportRetries(
  client: Pick<SupabaseClient, 'from'>,
  options: { nowMs?: number } = {},
): Promise<boolean> {
  const { data, error } = await exhaustedImportsQuery(client, 'id, generations!inner(status)', options.nowMs ?? Date.now())
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function abandon(
  client: SupabaseClient,
  row: ExhaustedImportRow,
): Promise<'abandoned' | 'skipped'> {
  let settlement: 'failed' | 'succeeded';
  try {
    settlement = await settleGenerationFailed(client, row.prediction_id, null, GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE);
  } catch (error) {
    // No generation carries the task any more: there is no hold to refund.
    if (error instanceof GenerationServiceError && error.status === 404) return 'skipped';
    throw error;
  }
  // `succeeded` is an import that landed in between: nothing failed.
  if (settlement !== 'failed') return 'skipped';

  logBackendInfo('generation_output_import_abandoned', {
    generationId: row.generation_id,
    importJobId: row.id,
    errorClass: classifyGenerationOutputImportError(row.last_error),
  });
  const generation = Array.isArray(row.generations) ? row.generations[0] : row.generations;
  // The notifier never throws, so it cannot undo the refund above it, and its
  // dedupe key absorbs a second send if this row is settled again.
  if (generation?.user_id) await notifyGenerationStatus(client, generation, 'failed');
  return 'abandoned';
}

/**
 * Closes the job of a generation settled here, conditional on the state it
 * was read in, so nothing claims it again for a render that is already
 * failed. Best effort: the settlement above is what matters, and a job left
 * open only fails against the failed generation and stays out of the alert.
 */
async function close(client: SupabaseClient, row: ExhaustedImportRow, nowMs: number): Promise<void> {
  try {
    const { error } = await client
      .from('generation_output_import_jobs')
      .update({ status: 'cancelled', locked_at: null, locked_by: null, updated_at: new Date(nowMs).toISOString() })
      .eq('id', row.id)
      .eq('status', row.status);
    if (error) throw error;
  } catch (error) {
    logBackendError('generation_output_import_close_failed', { importJobId: row.id, error });
  }
}

/** Stamps `updated_at` on a row this pass failed on, so the next pass reaches the rows behind it first. */
async function moveToBack(client: SupabaseClient, row: ExhaustedImportRow, nowMs: number): Promise<void> {
  try {
    const { error } = await client
      .from('generation_output_import_jobs')
      .update({ updated_at: new Date(nowMs).toISOString() })
      .eq('id', row.id);
    if (error) throw error;
  } catch (error) {
    logBackendError('generation_output_import_rotation_failed', { importJobId: row.id, error });
  }
}

function holdsLiveLease(row: ExhaustedImportRow, nowMs: number): boolean {
  if (row.status !== 'processing') return false;
  const lockedAtMs = row.locked_at ? Date.parse(row.locked_at) : Number.NaN;
  return Number.isFinite(lockedAtMs) && nowMs - lockedAtMs < GENERATION_OUTPUT_IMPORT_LOCK_TTL_SECONDS * 1000;
}

async function reopen(client: SupabaseClient, row: ExhaustedImportRow, nowMs: number): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString();
  // Conditional on `failed`: only this pass reopens an exhausted import, and
  // the run's job lock keeps two passes from running at once.
  const { data, error } = await client
    .from('generation_output_import_jobs')
    .update({ status: 'pending', next_attempt_at: nowIso, updated_at: nowIso })
    .eq('id', row.id)
    .eq('status', 'failed')
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Reopens exhausted imports due their hourly retry and fails, refunds and
 * announces every unfinished one whose window has ended. Bounded, and idempotent: a row it
 * settles is no longer active, so it is never selected again.
 */
export async function retryOrAbandonExhaustedGenerationOutputImports(params: {
  client: SupabaseClient;
  nowMs?: number;
  limit?: number;
  /** Absolute time after which no further row is started. */
  deadlineMs?: number;
}): Promise<GenerationOutputImportRetrySummary> {
  const nowMs = params.nowMs ?? Date.now();
  const limit = params.limit ?? GENERATION_OUTPUT_IMPORT_RETRY_BATCH_LIMIT;
  const summary: GenerationOutputImportRetrySummary = {
    eligible: 0, reopened: 0, abandoned: 0, skipped: 0, failed: 0, deferred: 0,
  };

  const { data, error } = await exhaustedImportsQuery(
    params.client,
    'id, status, locked_at, generation_id, prediction_id, provider_completed_at, created_at, completed_at, last_error, '
      + 'generations!inner(id, user_id, status, category, model, template_run_id)',
    nowMs,
  )
    // Least recently touched first: a row this pass could not settle is
    // stamped below and goes to the back, so a run of them cannot starve it.
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []) as unknown as ExhaustedImportRow[];
  summary.eligible = rows.length;
  const retryBeforeMs = nowMs - GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES * 60 * 1000;

  for (const row of rows) {
    if (params.deadlineMs !== undefined && Date.now() >= params.deadlineMs) {
      summary.deferred += 1;
      continue;
    }
    try {
      if (generationOutputImportWindowEnded(row, nowMs)) {
        // A worker still inside its lease may be saving the file right now.
        if (holdsLiveLease(row, nowMs)) {
          summary.skipped += 1;
          continue;
        }
        const outcome = await abandon(params.client, row);
        if (outcome === 'abandoned') await close(params.client, row, nowMs);
        summary[outcome] += 1;
        continue;
      }
      if (row.status !== 'failed') {
        summary.skipped += 1;
        continue;
      }
      const lastAttemptMs = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
      if (Number.isFinite(lastAttemptMs) && lastAttemptMs > retryBeforeMs) {
        summary.skipped += 1;
        continue;
      }
      if (await reopen(params.client, row, nowMs)) summary.reopened += 1;
      else summary.skipped += 1;
    } catch (rowError) {
      summary.failed += 1;
      logBackendError('generation_output_import_retry_failed', {
        generationId: row.generation_id,
        importJobId: row.id,
        error: rowError,
      });
      await moveToBack(params.client, row, nowMs);
    }
  }

  return summary;
}
