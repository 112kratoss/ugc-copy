import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo } from '@/lib/backend-logger';
import { getPublicGenerationStartFailure } from '@/lib/generation-services';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';

/**
 * Stalled-generation reaper.
 *
 * Completion normally arrives through the KIE webhook and the durable
 * `generation_completion_jobs` queue. When a webhook is lost and the user
 * never reopens the app, a generation can sit in an active status forever
 * with its credit hold in place. The reaper is the automatic remediation for
 * that gap: each generation-completions tick it reconciles a small, oldest-
 * first batch of stalled work using the same idempotent settlement paths the
 * webhook pipeline uses, so replays and races settle credits exactly once.
 *
 * Two bounded passes per tick:
 *
 * 1. Provider sync — active generations (`waiting`/`processing`) that have a
 *    provider task id and are older than the sync TTL are re-polled through
 *    `syncGenerationStatusByPredictionId`, which drives them to a terminal
 *    state exactly once when the provider has finished.
 * 2. Start-failure settlement — `pending` generations that never received a
 *    provider task id and are older than the start-failure TTL are settled
 *    through the atomic `settle_generation_start_failed` RPC (the same
 *    pgTAP-covered path the start services use), refunding the credit hold
 *    at most once. The RPC refuses rows that gained a provider task or
 *    already settled, so a late webhook can never be double-settled. Template
 *    generations route to the template variant so the run step fails with the
 *    generation instead of stranding the run in `processing`.
 *
 * This second pass is also the single settlement point for ambiguous provider
 * submissions (F14). A task-creation timeout cannot tell acceptance from
 * rejection, so the start services hold the generation rather than refunding it
 * on the spot; a held row has exactly the shape this pass already selects, and
 * its `submission_unknown_at` marker is what distinguishes "the provider may
 * have run and billed for this" from a clean start failure. The window here is
 * deliberately the only clock on those rows.
 *
 * One bad row never aborts the batch: per-row failures are logged, counted,
 * and retried naturally on a later tick because the row stays eligible.
 */

export const STALLED_GENERATION_SYNC_AFTER_MINUTES = 30;
export const STALLED_GENERATION_SYNC_BATCH_LIMIT = 10;
export const STALLED_GENERATION_START_FAILURE_AFTER_MINUTES = 45;
export const STALLED_GENERATION_START_FAILURE_BATCH_LIMIT = 10;

// Soft in-run budget so a slow provider cannot push the shared
// generation-completions run into the scheduler's function limit. Rows left
// unattempted stay eligible and are picked up on the next tick.
export const STALLED_GENERATION_REAP_TIME_BUDGET_MS = 120_000;

const STALLED_SYNCABLE_STATUSES = ['waiting', 'processing'] as const;

// Classify a synthetic gateway timeout through the shared start-failure
// classifier so the user-facing copy stays consistent with every other
// start-failure surface instead of inventing new failure text here.
const START_FAILURE_TIMEOUT_SIGNAL = {
  status: 504,
  message: 'Generation start timed out before a provider task was created.',
};

type GenerationsProbeClient = Pick<SupabaseClient, 'from'>;

type StalledGenerationRow = {
  id: string;
  prediction_id: string | null;
  status: string;
  created_at: string;
  template_run_id?: string | null;
  template_run_step_id?: string | null;
  submission_unknown_at?: string | null;
};

/**
 * A template generation carries a run step whose status has to move with it.
 * `settle_generation_start_failed` refunds the credit hold but never touches
 * `template_run_steps`, so settling a template row through it leaves the step
 * stuck in `processing` and the run unable to finish.
 *
 * This was previously near-unreachable -- template starts settle synchronously,
 * so a row only arrived here when that settlement had itself failed. Holding
 * ambiguous submissions makes rows reaching the reaper ordinary rather than
 * exceptional, so the branch has to be right before it carries real traffic.
 */
function startFailureSettlementRpc(row: StalledGenerationRow): string {
  return row.template_run_id && row.template_run_step_id
    ? 'settle_template_generation_start_failed'
    : 'settle_generation_start_failed';
}

export type StalledGenerationReapSummary = {
  providerSync: {
    eligible: number;
    reconciled: number;
    stillActive: number;
    skipped: number;
    failed: number;
    deferred: number;
  };
  startFailures: {
    eligible: number;
    settled: number;
    skipped: number;
    failed: number;
    deferred: number;
    /** Subset of `settled` whose submission outcome was never confirmed. */
    submissionUnknown: number;
  };
};

function hasRows(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0;
}

function assertValidTimestamp(nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Stalled generation reap time must be a valid timestamp');
  }
}

function assertValidBatchLimit(limit: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Stalled generation ${label} batch limit must be a positive integer`);
  }
}

function syncCutoffIso(nowMs: number): string {
  return new Date(nowMs - STALLED_GENERATION_SYNC_AFTER_MINUTES * 60 * 1000).toISOString();
}

function startFailureCutoffIso(nowMs: number): string {
  return new Date(nowMs - STALLED_GENERATION_START_FAILURE_AFTER_MINUTES * 60 * 1000).toISOString();
}

export async function hasStalledGenerationWork(
  client: GenerationsProbeClient,
  options: { nowMs?: number } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  assertValidTimestamp(nowMs);

  const stalledActive = await client
    .from('generations')
    .select('id')
    .in('status', [...STALLED_SYNCABLE_STATUSES])
    .not('prediction_id', 'is', null)
    .lt('created_at', syncCutoffIso(nowMs))
    .limit(1);

  if (stalledActive.error) throw stalledActive.error;
  if (hasRows(stalledActive.data)) return true;

  const stalledPending = await client
    .from('generations')
    .select('id')
    .eq('status', 'pending')
    .is('prediction_id', null)
    .lt('created_at', startFailureCutoffIso(nowMs))
    .limit(1);

  if (stalledPending.error) throw stalledPending.error;
  return hasRows(stalledPending.data);
}

async function loadStalledProviderSyncRows(
  client: GenerationsProbeClient,
  params: { nowMs: number; limit: number },
): Promise<StalledGenerationRow[]> {
  const { data, error } = await client
    .from('generations')
    .select('id, prediction_id, status, created_at')
    .in('status', [...STALLED_SYNCABLE_STATUSES])
    .not('prediction_id', 'is', null)
    .lt('created_at', syncCutoffIso(params.nowMs))
    .order('created_at', { ascending: true })
    .limit(params.limit);

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as StalledGenerationRow[];
}

async function loadStalledStartFailureRows(
  client: GenerationsProbeClient,
  params: { nowMs: number; limit: number },
): Promise<StalledGenerationRow[]> {
  const { data, error } = await client
    .from('generations')
    .select('id, prediction_id, status, created_at, template_run_id, template_run_step_id, submission_unknown_at')
    .eq('status', 'pending')
    .is('prediction_id', null)
    .lt('created_at', startFailureCutoffIso(params.nowMs))
    .order('created_at', { ascending: true })
    .limit(params.limit);

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as StalledGenerationRow[];
}

export async function reapStalledGenerations(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  nowMs?: number;
  syncLimit?: number;
  startFailureLimit?: number;
  timeBudgetMs?: number;
}): Promise<StalledGenerationReapSummary> {
  const nowMs = params.nowMs ?? Date.now();
  const syncLimit = params.syncLimit ?? STALLED_GENERATION_SYNC_BATCH_LIMIT;
  const startFailureLimit = params.startFailureLimit ?? STALLED_GENERATION_START_FAILURE_BATCH_LIMIT;
  const timeBudgetMs = params.timeBudgetMs ?? STALLED_GENERATION_REAP_TIME_BUDGET_MS;

  assertValidTimestamp(nowMs);
  assertValidBatchLimit(syncLimit, 'provider sync');
  assertValidBatchLimit(startFailureLimit, 'start failure');
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 0) {
    throw new Error('Stalled generation reap time budget must be a non-negative number');
  }

  // The deadline is measured from real elapsed time, not the caller's logical
  // clock, so the reaper backs off when the completion drain has already
  // consumed most of the shared run.
  const deadlineMs = Date.now() + timeBudgetMs;
  const summary: StalledGenerationReapSummary = {
    providerSync: { eligible: 0, reconciled: 0, stillActive: 0, skipped: 0, failed: 0, deferred: 0 },
    startFailures: { eligible: 0, settled: 0, skipped: 0, failed: 0, deferred: 0, submissionUnknown: 0 },
  };

  const syncRows = await loadStalledProviderSyncRows(params.supabase, { nowMs, limit: syncLimit });
  summary.providerSync.eligible = syncRows.length;

  for (const row of syncRows) {
    if (Date.now() >= deadlineMs) {
      summary.providerSync.deferred += 1;
      continue;
    }
    if (!row.prediction_id) {
      summary.providerSync.skipped += 1;
      continue;
    }

    try {
      const result = await syncGenerationStatusByPredictionId({
        supabase: params.supabase,
        creditSupabase: params.creditSupabase,
        predictionId: row.prediction_id,
      });

      if (result.found && (result.status === 'succeeded' || result.status === 'failed')) {
        summary.providerSync.reconciled += 1;
        logBackendInfo('stalled_generation_reconciled', {
          generationId: row.id,
          predictionId: row.prediction_id,
          status: result.status,
          createdAt: row.created_at,
        });
      } else if (result.found && (result.status === 'waiting' || result.status === 'processing')) {
        summary.providerSync.stillActive += 1;
      } else {
        summary.providerSync.skipped += 1;
      }
    } catch (error) {
      summary.providerSync.failed += 1;
      logBackendError('stalled_generation_sync_failed', {
        generationId: row.id,
        predictionId: row.prediction_id,
        error,
      });
    }
  }

  const startFailureRows = await loadStalledStartFailureRows(params.supabase, {
    nowMs,
    limit: startFailureLimit,
  });
  summary.startFailures.eligible = startFailureRows.length;
  const failureMessage = getPublicGenerationStartFailure(START_FAILURE_TIMEOUT_SIGNAL).message;

  for (const row of startFailureRows) {
    if (Date.now() >= deadlineMs) {
      summary.startFailures.deferred += 1;
      continue;
    }

    try {
      const { data, error } = await params.creditSupabase.rpc(startFailureSettlementRpc(row), {
        p_generation_id: row.id,
        p_error_message: failureMessage,
      });
      if (error) throw error;

      const status = data && typeof data === 'object' && 'status' in data
        ? (data as { status?: unknown }).status
        : null;

      if (status === 'failed' || status === 'already_failed') {
        summary.startFailures.settled += 1;
        // An ambiguous submission that expired is materially different from a
        // generation that never reached the provider: Kie may have run and
        // billed for this task, so the settlement is a candidate discrepancy
        // rather than a clean refund.
        const submissionUnknown = Boolean(row.submission_unknown_at);
        if (submissionUnknown) {
          summary.startFailures.submissionUnknown += 1;
        }
        logBackendInfo('stalled_generation_start_failure_settled', {
          generationId: row.id,
          settlement: status,
          createdAt: row.created_at,
          submissionUnknown,
          ...(row.template_run_id ? { templateRunId: row.template_run_id } : {}),
        });
      } else if (status === 'provider_task_attached' || status === 'already_succeeded') {
        // A provider task or terminal settlement raced in after our read; the
        // sync path (or the webhook pipeline) owns this row now.
        summary.startFailures.skipped += 1;
      } else {
        summary.startFailures.failed += 1;
        logBackendError('stalled_generation_start_failure_settlement_failed', {
          generationId: row.id,
          settlementStatus: status,
        });
      }
    } catch (error) {
      summary.startFailures.failed += 1;
      logBackendError('stalled_generation_start_failure_settlement_failed', {
        generationId: row.id,
        error,
      });
    }
  }

  return summary;
}
