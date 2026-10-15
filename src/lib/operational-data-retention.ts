/**
 * Operational-data retention sweep.
 *
 * Thin wrapper over the `prune_operational_backend_data` RPC. All retention
 * policy lives in the database function so the windows are enforced in one
 * place and cannot drift between callers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { reclaimExpiredUploadReservations } from '@/lib/upload-finalization';
import { logBackendError } from '@/lib/backend-logger';

/**
 * Idle-guest retention (D5, 2026-10-15): at most this many guest identities are
 * deleted per run, the longest unused first. The job runs daily, so a backlog
 * drains over the following runs.
 */
export const IDLE_GUEST_RETENTION_BATCH_LIMIT = 100;

/** The most of a run the guest deletions may take. */
export const IDLE_GUEST_RETENTION_TIME_BUDGET_MS = 60_000;

/**
 * No step of the run starts work past this point of its 300 s function budget.
 * The guest deletions run last and yield to everything before them: the upload
 * reclaim alone may take four minutes.
 */
export const OPERATIONAL_RETENTION_RUN_BUDGET_MS = 270_000;

/** Consecutive failed deletions after which the run stops asking Auth. */
const IDLE_GUEST_MAX_CONSECUTIVE_FAILURES = 3;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdleGuestRetentionSummary = {
  /** Guests `list_idle_guest_identities` named this run (at most the batch limit). */
  idleGuestCandidates: number;
  /** Deleted through the Auth admin API. */
  idleGuestsDeleted: number;
  /** Left alone: in use again at the re-check, or already gone. */
  idleGuestsSkipped: number;
  idleGuestDeletionFailures: number;
  /** A full batch was listed, so the next run has more to do. */
  idleGuestBatchLimitReached: boolean;
  /** The run's time ran out before every listed guest was asked about. */
  idleGuestTimeBudgetReached: boolean;
};

export type OperationalRetentionSummary = IdleGuestRetentionSummary & {
  /** Failed best-effort operations, retained in the durable job-run summary. */
  supplementaryPruneFailures: string[];
  jobRunsDeleted: number;
  rateLimitsDeleted: number;
  completionJobsDeleted: number;
  providerEventsDeleted: number;
  providerChecksDeleted: number;
  totalDeleted: number;
  batchLimitReached: boolean;
  shareEventsDeleted: number;
  profileShareEventsDeleted: number;
  abandonedFreeUnlockOrdersDeleted: number;
  accountMergeTicketsDeleted: number;
  uploadByteReservationsDeleted: number;
  expiredUploadReservationsScanned: number;
  expiredUploadReservationsHandled: number;
  expiredUploadObjectsDeleted: number;
  expiredUploadReservationFailures: number;
  /**
   * The two halves of `expiredUploadReservationsHandled` that a release does
   * not account for. Without them a run that advanced nothing is impossible to
   * tell from one with no work, which is what a zero-failure sweep looked like
   * while a backlog aged past its SLO.
   */
  expiredUploadReservationsDeferred: number;
  expiredUploadReservationFirstClaims: number;
  expiredUploadReservationsHeld: number;
  uploadReclaimScanLimitReached: boolean;
  uploadReclaimTimeBudgetReached: boolean;
  oldestExpiredUploadCandidateAt: string | null;
};

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The user ids of `list_idle_guest_identities` rows, or null for any other shape. */
function parseIdleGuestIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const row of value) {
    const userId = row && typeof row === 'object'
      ? (row as { user_id?: unknown }).user_id
      : undefined;
    if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) return null;
    ids.push(userId);
  }
  return ids;
}

function isMissingAuthUserError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const record = error as { status?: unknown; statusCode?: unknown };
  return String(record.status ?? record.statusCode ?? '') === '404';
}

/**
 * Deletes the guest identities nobody has used for 90 days and that hold
 * nothing (D5): `list_idle_guest_identities` decides who, and each is asked
 * about again, on its own, right before its Auth user is deleted, so a guest
 * that came back while the run was under way is left alone. The Auth delete is
 * the one account deletion uses; the database cascades what a candidate can
 * still have (its feed preferences and telemetry).
 *
 * Best-effort, like the other supplementary steps: it never throws, and
 * reports what failed through `onFailure`.
 */
export async function deleteIdleGuestIdentities(
  client: SupabaseClient,
  options: {
    now?: Date;
    limit?: number;
    /** Wall-clock ms after which no further guest is started. */
    deadlineMs?: number;
    clock?: () => number;
    onFailure?: (operation: string, error: unknown, userId?: string) => void;
  } = {},
): Promise<IdleGuestRetentionSummary> {
  const clock = options.clock ?? Date.now;
  const limit = Math.max(1, Math.floor(options.limit ?? IDLE_GUEST_RETENTION_BATCH_LIMIT));
  const deadlineMs = options.deadlineMs ?? clock() + IDLE_GUEST_RETENTION_TIME_BUDGET_MS;
  const nowArgument = options.now ? { p_now: options.now.toISOString() } : {};
  const summary: IdleGuestRetentionSummary = {
    idleGuestCandidates: 0,
    idleGuestsDeleted: 0,
    idleGuestsSkipped: 0,
    idleGuestDeletionFailures: 0,
    idleGuestBatchLimitReached: false,
    idleGuestTimeBudgetReached: false,
  };

  let candidates: string[];
  try {
    const { data, error } = await client.rpc('list_idle_guest_identities', {
      ...nowArgument,
      p_limit: limit,
    });
    if (error) throw error;
    const ids = parseIdleGuestIds(data);
    if (!ids) throw new Error('list_idle_guest_identities answered in an unexpected shape.');
    candidates = ids.slice(0, limit);
  } catch (error) {
    options.onFailure?.('list_idle_guest_identities', error);
    return summary;
  }

  summary.idleGuestCandidates = candidates.length;
  summary.idleGuestBatchLimitReached = candidates.length >= limit;

  let consecutiveFailures = 0;
  for (const userId of candidates) {
    if (clock() >= deadlineMs) {
      summary.idleGuestTimeBudgetReached = true;
      break;
    }
    // Auth is failing every delete: stop rather than spend the run on it. The
    // rest stay candidates for the next run.
    if (consecutiveFailures >= IDLE_GUEST_MAX_CONSECUTIVE_FAILURES) break;

    try {
      const recheck = await client.rpc('list_idle_guest_identities', {
        ...nowArgument,
        p_limit: 1,
        p_user_id: userId,
      });
      if (recheck.error) throw recheck.error;
      const stillIdle = parseIdleGuestIds(recheck.data);
      if (!stillIdle) throw new Error('list_idle_guest_identities answered in an unexpected shape.');
      if (!stillIdle.includes(userId)) {
        summary.idleGuestsSkipped += 1;
        consecutiveFailures = 0;
        continue;
      }

      const { error } = await client.auth.admin.deleteUser(userId);
      if (error && !isMissingAuthUserError(error)) throw error;
      if (error) {
        summary.idleGuestsSkipped += 1;
      } else {
        summary.idleGuestsDeleted += 1;
      }
      consecutiveFailures = 0;
    } catch (error) {
      summary.idleGuestDeletionFailures += 1;
      consecutiveFailures += 1;
      options.onFailure?.('delete_idle_guest_identity', error, userId);
    }
  }

  return summary;
}

export async function pruneOperationalBackendData(
  client: SupabaseClient,
  options: {
    now?: Date;
    maxDeletesPerTable?: number;
    idleGuestDeletionLimit?: number;
    clock?: () => number;
  } = {},
): Promise<OperationalRetentionSummary> {
  const clock = options.clock ?? Date.now;
  const runStartedAtMs = clock();

  const { data, error } = await client.rpc('prune_operational_backend_data', {
    ...(options.now ? { p_now: options.now.toISOString() } : {}),
    ...(options.maxDeletesPerTable !== undefined
      ? { p_max_deletes_per_table: options.maxDeletesPerTable }
      : {}),
  });

  if (error) throw error;

  const summary = (data ?? {}) as Record<string, unknown>;

  // Tables the main retention function does not cover: the two append-only,
  // unbounded share telemetry ledgers, and the synthetic $0 orders a retried
  // free unlock leaves behind. All best-effort -- a failure here must not fail
  // the whole retention run.
  const supplementaryPruneFailures: string[] = [];
  async function pruneSupplementary(operation: string, args: Record<string, unknown> = {}) {
    try {
      const result = await client.rpc(operation, args);
      if (result.error) throw result.error;
      return toCount(result.data);
    } catch (error) {
      supplementaryPruneFailures.push(operation);
      logBackendError('operational_retention_supplementary_prune_failed', { operation, error });
      return 0;
    }
  }

  const shareEventsDeleted = await pruneSupplementary('prune_post_share_events');
  const profileShareEventsDeleted = await pruneSupplementary('prune_profile_share_events');
  const abandonedFreeUnlockOrdersDeleted = await pruneSupplementary('prune_abandoned_free_unlock_orders');
  const accountMergeTicketsDeleted = await pruneSupplementary('prune_account_merge_tickets', {
    p_limit: options.maxDeletesPerTable ?? 5000,
  });

  // Expiry is not proof of absence. Delete/prove each unfinalized object first;
  // only rows this worker releases are eligible for the bookkeeping prune.
  const uploadReclaim = await reclaimExpiredUploadReservations(client, {
    now: options.now,
    limit: options.maxDeletesPerTable ?? 500,
  });

  const uploadByteReservationsDeleted = await pruneSupplementary('prune_upload_byte_reservations', {
    p_limit: options.maxDeletesPerTable ?? 5000,
  });

  // Last, and with whatever time is left: a guest that waits a day loses
  // nothing. Also best-effort, and each failure is named once in the summary.
  const idleGuests = await deleteIdleGuestIdentities(client, {
    now: options.now,
    limit: options.idleGuestDeletionLimit ?? IDLE_GUEST_RETENTION_BATCH_LIMIT,
    deadlineMs: Math.min(
      clock() + IDLE_GUEST_RETENTION_TIME_BUDGET_MS,
      runStartedAtMs + OPERATIONAL_RETENTION_RUN_BUDGET_MS,
    ),
    clock,
    onFailure: (operation, failure, userId) => {
      if (!supplementaryPruneFailures.includes(operation)) supplementaryPruneFailures.push(operation);
      logBackendError('operational_retention_idle_guest_failed', {
        operation,
        ...(userId ? { userId } : {}),
        error: failure,
      });
    },
  });

  return {
    supplementaryPruneFailures,
    shareEventsDeleted,
    profileShareEventsDeleted,
    abandonedFreeUnlockOrdersDeleted,
    accountMergeTicketsDeleted,
    uploadByteReservationsDeleted,
    expiredUploadReservationsScanned: uploadReclaim.scanned,
    expiredUploadReservationsHandled: uploadReclaim.handled,
    expiredUploadObjectsDeleted: uploadReclaim.objectsDeleted,
    expiredUploadReservationFailures: uploadReclaim.failed,
    expiredUploadReservationsDeferred: uploadReclaim.deferred,
    expiredUploadReservationFirstClaims: uploadReclaim.firstClaims,
    expiredUploadReservationsHeld: uploadReclaim.held,
    uploadReclaimScanLimitReached: uploadReclaim.scanLimitReached,
    uploadReclaimTimeBudgetReached: uploadReclaim.timeBudgetReached,
    oldestExpiredUploadCandidateAt: uploadReclaim.oldestCandidateExpiresAt,
    ...idleGuests,
    jobRunsDeleted: toCount(summary.job_runs_deleted),
    rateLimitsDeleted: toCount(summary.rate_limits_deleted),
    completionJobsDeleted: toCount(summary.completion_jobs_deleted),
    providerEventsDeleted: toCount(summary.provider_events_deleted),
    providerChecksDeleted: toCount(summary.provider_checks_deleted),
    totalDeleted: toCount(summary.total_deleted),
    // True when a table hit its per-run cap, meaning a backlog remains and the
    // next scheduled run still has work to do.
    batchLimitReached: summary.batch_limit_reached === true,
  };
}
