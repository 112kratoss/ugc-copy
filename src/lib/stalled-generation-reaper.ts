import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo } from '@/lib/backend-logger';
import { GenerationServiceError } from '@/lib/generation-service-core';
import { getPublicGenerationStartFailure } from '@/lib/generation-services';
import { settleGenerationFailed } from '@/lib/generation-settlement';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';

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
 *    state exactly once when the provider has finished. Rows are taken least
 *    recently tried first (`provider_sync_attempted_at`, written before each
 *    attempt), so a handful of rows that never resolve cannot keep the pass
 *    from reaching a newer one whose callback was lost. A generation whose
 *    provider already finished has an output import job and is left to the
 *    import pipeline, which owns its retries, its 24-hour window and its
 *    refund (generation-output-import-retries.ts). A row the provider still
 *    reports as running, or no longer knows, after
 *    STALLED_GENERATION_GIVE_UP_AFTER_HOURS is failed and refunded through
 *    `settle_generation_failed`, the settlement an exhausted completion job
 *    uses. A provider callback that arrives after that finds the row failed
 *    and changes nothing: no second refund and no reopened import.
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
 * Both passes tell the creator when they settle a failure: the first inside the
 * sync, and the second with the same "Your … failed" notification once the
 * hold is released, which is when the start service said the credits would
 * come back.
 *
 * One bad row never aborts the batch: per-row failures are logged, counted,
 * and retried on a later tick, behind the rows not yet tried, until the
 * maximum age ends it.
 */

export const STALLED_GENERATION_SYNC_AFTER_MINUTES = 30;
export const STALLED_GENERATION_SYNC_BATCH_LIMIT = 10;
export const STALLED_GENERATION_START_FAILURE_AFTER_MINUTES = 45;
export const STALLED_GENERATION_START_FAILURE_BATCH_LIMIT = 10;
/** A provider task still running, or unknown to the provider, after this is given up on and refunded. */
export const STALLED_GENERATION_GIVE_UP_AFTER_HOURS = 24;

// Admission budget: no row is started after it, so a slow provider cannot
// push the shared generation-completions run into its function limit. The
// caller also passes the run's own deadline (`deadlineMs`); the earlier wins.
// A row already started runs to the end of its provider poll (at most three
// ten-second tries). Rows left unattempted stay eligible for the next tick.
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
  user_id?: string | null;
  category?: string | null;
  model?: string | null;
  template_run_id?: string | null;
  template_run_step_id?: string | null;
  submission_unknown_at?: string | null;
  provider_sync_attempted_at?: string | null;
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
    /** Past the maximum age: failed and refunded here, terminal transitions the run wakes steps for. */
    abandoned: number;
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

/** Candidates read per tick, as a multiple of the batch: room to set aside rows the import pipeline owns. */
export const STALLED_GENERATION_SYNC_CANDIDATE_FACTOR = 3;

/**
 * The provider-sync batch: active rows least recently tried first, without
 * the ones whose provider already finished. Those have an output import job
 * and belong to the import pipeline (its retries, its window, its refund).
 *
 * Two plain bounded reads rather than an embedded anti-join, so the query is
 * the same on PostgREST and on the database-backed test harness: up to three
 * batches of candidates, then their import jobs by id. A candidate set aside
 * is returned too, so the caller stamps it and it rotates behind the rest
 * instead of filling the head of every read.
 */
async function loadStalledProviderSyncRows(
  client: GenerationsProbeClient,
  params: { nowMs: number; limit: number },
): Promise<{ rows: StalledGenerationRow[]; importOwned: StalledGenerationRow[] }> {
  const { data, error } = await client
    .from('generations')
    .select('id, prediction_id, status, created_at, user_id, category, model, template_run_id, provider_sync_attempted_at')
    .in('status', [...STALLED_SYNCABLE_STATUSES])
    .not('prediction_id', 'is', null)
    .lt('created_at', syncCutoffIso(params.nowMs))
    .order('provider_sync_attempted_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(params.limit * STALLED_GENERATION_SYNC_CANDIDATE_FACTOR);

  if (error) throw error;
  const candidates = (Array.isArray(data) ? data : []) as StalledGenerationRow[];
  if (candidates.length === 0) return { rows: [], importOwned: [] };

  const ids = candidates.map((row) => row.id);
  const imports = await client
    .from('generation_output_import_jobs')
    .select('generation_id')
    .in('generation_id', ids)
    .limit(ids.length);
  if (imports.error) throw imports.error;
  const owned = new Set(
    (Array.isArray(imports.data) ? imports.data : [])
      .map((row) => (row as { generation_id?: unknown }).generation_id)
      .filter((id): id is string => typeof id === 'string'),
  );

  return {
    rows: candidates.filter((row) => !owned.has(row.id)).slice(0, params.limit),
    importOwned: candidates.filter((row) => owned.has(row.id)),
  };
}

async function loadStalledStartFailureRows(
  client: GenerationsProbeClient,
  params: { nowMs: number; limit: number },
): Promise<StalledGenerationRow[]> {
  const { data, error } = await client
    .from('generations')
    .select('id, user_id, category, model, prediction_id, status, created_at, template_run_id, template_run_step_id, submission_unknown_at')
    .eq('status', 'pending')
    .is('prediction_id', null)
    .lt('created_at', startFailureCutoffIso(params.nowMs))
    .order('created_at', { ascending: true })
    .limit(params.limit);

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as StalledGenerationRow[];
}

function isPastMaximumAge(row: StalledGenerationRow, nowMs: number): boolean {
  const createdAtMs = Date.parse(row.created_at);
  return Number.isFinite(createdAtMs)
    && nowMs - createdAtMs >= STALLED_GENERATION_GIVE_UP_AFTER_HOURS * 60 * 60 * 1000;
}

async function recordProviderSyncAttempt(
  client: SupabaseClient,
  row: StalledGenerationRow,
  nowMs: number,
): Promise<void> {
  // Rotation is an ordering aid, not a precondition: a row whose stamp did not
  // land is still worth asking about now.
  try {
    const result = await client
      .from('generations')
      .update({ provider_sync_attempted_at: new Date(nowMs).toISOString() })
      .eq('id', row.id);
    if (result?.error) throw result.error;
  } catch (error) {
    logBackendError('stalled_generation_sync_attempt_stamp_failed', { generationId: row.id, error });
  }
}

/**
 * Fails and refunds a row past the maximum age. `already_succeeded` (the
 * render landed in between) and a row that no longer exists settle nothing.
 */
async function abandonStalledGeneration(
  creditSupabase: SupabaseClient,
  row: StalledGenerationRow & { prediction_id: string },
  lastStatus: string,
): Promise<'abandoned' | 'skipped'> {
  let settlement: 'failed' | 'succeeded';
  try {
    settlement = await settleGenerationFailed(
      creditSupabase,
      row.prediction_id,
      null,
      `The provider never reported a final result within ${STALLED_GENERATION_GIVE_UP_AFTER_HOURS} hours (last status: ${lastStatus})`,
    );
  } catch (error) {
    if (error instanceof GenerationServiceError && error.status === 404) return 'skipped';
    throw error;
  }
  if (settlement !== 'failed') return 'skipped';

  logBackendInfo('stalled_generation_abandoned', {
    generationId: row.id,
    predictionId: row.prediction_id,
    createdAt: row.created_at,
    lastStatus,
  });
  if (row.user_id) {
    await notifyGenerationStatus(creditSupabase, {
      id: row.id,
      user_id: row.user_id,
      category: row.category,
      model: row.model,
      template_run_id: row.template_run_id,
    }, 'failed');
  }
  return 'abandoned';
}

export async function reapStalledGenerations(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  nowMs?: number;
  syncLimit?: number;
  startFailureLimit?: number;
  timeBudgetMs?: number;
  /** The shared run's own admission deadline (absolute ms); the earlier of it and the budget wins. */
  deadlineMs?: number;
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

  // Real elapsed time, not the caller's logical clock. The budget starts now;
  // the caller's `deadlineMs` is what is left of the shared run once the
  // completion drain has had its share, so the earlier of the two applies.
  const deadlineMs = Math.min(Date.now() + timeBudgetMs, params.deadlineMs ?? Number.POSITIVE_INFINITY);
  const summary: StalledGenerationReapSummary = {
    providerSync: { eligible: 0, reconciled: 0, stillActive: 0, abandoned: 0, skipped: 0, failed: 0, deferred: 0 },
    startFailures: { eligible: 0, settled: 0, skipped: 0, failed: 0, deferred: 0, submissionUnknown: 0 },
  };

  const { rows: syncRows, importOwned } = await loadStalledProviderSyncRows(params.supabase, { nowMs, limit: syncLimit });
  for (const row of importOwned) await recordProviderSyncAttempt(params.supabase, row, nowMs);
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

    await recordProviderSyncAttempt(params.supabase, row, nowMs);
    const syncableRow = row as StalledGenerationRow & { prediction_id: string };

    try {
      let lastStatus: string | null = null;
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
          continue;
        }
        if (!(result.found && (result.status === 'waiting' || result.status === 'processing'))) {
          summary.providerSync.skipped += 1;
          continue;
        }
        lastStatus = result.status;
      } catch (error) {
        // Inside the maximum age a failed poll is retried on a later tick.
        // Past it, a task the provider cannot answer for is given up on.
        if (!isPastMaximumAge(row, nowMs)) throw error;
        lastStatus = `provider status check failed: ${error instanceof Error ? error.message : String(error)}`;
        logBackendError('stalled_generation_sync_failed', {
          generationId: row.id,
          predictionId: row.prediction_id,
          error,
        });
      }

      if (!isPastMaximumAge(row, nowMs)) {
        summary.providerSync.stillActive += 1;
        continue;
      }
      summary.providerSync[await abandonStalledGeneration(params.creditSupabase, syncableRow, lastStatus ?? 'unknown')] += 1;
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
      let submissionUnknown = Boolean(row.submission_unknown_at);
      if (!submissionUnknown) {
        // A start may lose its marker write or die after dispatch. Preserve
        // evidence before releasing the hold so a later callback can still
        // record the provider-cost discrepancy. No task ID means we cannot
        // distinguish that case from a request that never reached the provider.
        const marker = await params.creditSupabase.rpc('mark_generation_submission_unknown', {
          p_generation_id: row.id,
        });
        if (marker.error) throw marker.error;
        const markerStatus = marker.data && typeof marker.data === 'object' && 'status' in marker.data
          ? (marker.data as { status?: unknown }).status : null;
        if (markerStatus === 'provider_task_attached' || markerStatus === 'already_settled' || markerStatus === 'missing') {
          summary.startFailures.skipped += 1;
          continue;
        }
        if (markerStatus !== 'held' && markerStatus !== 'already_marked') {
          throw new Error('Unable to confirm stalled generation ambiguity marker.');
        }
        submissionUnknown = true;
      }
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
        // An expired taskless start may have reached the provider, including
        // when its initial marker was lost. Count uncertainty conservatively;
        // a late callback is the evidence that creates a reconciliation row.
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
        // Only `failed` means this run released the hold; `already_failed` is a
        // row something else had refunded first. The notifier cannot throw, so
        // it cannot make a settled row count as a failed one below.
        if (status === 'failed' && row.user_id) {
          await notifyGenerationStatus(params.creditSupabase, {
            id: row.id,
            user_id: row.user_id,
            category: row.category,
            model: row.model,
            template_run_id: row.template_run_id,
          }, 'failed');
        }
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
