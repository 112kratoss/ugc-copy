/**
 * Operational-data retention sweep.
 *
 * Thin wrapper over the `prune_operational_backend_data` RPC. All retention
 * policy lives in the database function so the windows are enforced in one
 * place and cannot drift between callers.
 *
 * Each prune deletes one bounded batch per table per call, so this wrapper
 * calls it again while a batch comes back full, until the backlog is gone or
 * the run's time for that step is up (usage audit, 2026-11-04). The cap bounds
 * a transaction, not a day: a backlog drains in one run rather than at 5,000
 * rows a day.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AccountDeletionNotStartedError,
  GuestAccountLinkedError,
  finishInitialAccountDeletion,
  markAccountDeletionStage,
  startInitialAccountDeletion,
} from '@/lib/account-deletion-service';
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
 * The guest deletions run last and yield to everything before them.
 */
export const OPERATIONAL_RETENTION_RUN_BUDGET_MS = 270_000;

/**
 * The run's timeline, in ms from its start. Each step's first batch always
 * runs, as it did before the steps looped; a further batch starts only before
 * the step's mark. The marks leave the guest steps at least a minute, and end
 * the reservation sweep well inside the five minutes its first-claim margin
 * allows (`UPLOAD_RECLAIM_FIRST_PASS_MARGIN_MS`).
 */
export const OPERATIONAL_RETENTION_PRUNE_PHASE_END_MS = 60_000;
export const OPERATIONAL_RETENTION_SUPPLEMENTARY_PHASE_END_MS = 90_000;
export const OPERATIONAL_RETENTION_RECLAIM_PHASE_END_MS = 210_000;

/**
 * A backstop on the batches of any one prune in a run. The time marks are the
 * real bound; this only stops a pathological loop of instant full batches.
 */
export const OPERATIONAL_RETENTION_MAX_BATCHES = 40;

/**
 * Batch size of the supplementary prunes. The share-event and free-unlock
 * prunes delete 5,000 rows a call in SQL, and the merge-ticket and
 * byte-reservation prunes are passed it.
 */
const SUPPLEMENTARY_PRUNE_BATCH = 5000;

/**
 * Actions the expired-reservation sweep may take in a run: the most
 * `reclaimExpiredUploadReservations` accepts. It was 500, which made the sweep
 * a fixed 500 a day; its time budget is the real bound now.
 */
export const EXPIRED_UPLOAD_RESERVATION_RECLAIM_LIMIT = 5000;

/**
 * Idle guests with content (usage audit, 2026-11-04): at most this many are
 * retired per run, each through the whole account-deletion pipeline (a storage
 * sweep and an Auth delete apiece), the longest unused first. The 180-day
 * window is the owner's decision and lives in
 * `list_idle_guest_identities_with_content`.
 */
export const IDLE_CONTENT_GUEST_RETIREMENT_BATCH_LIMIT = 10;

/** The most of a run the retirements may take. */
export const IDLE_CONTENT_GUEST_RETIREMENT_TIME_BUDGET_MS = 60_000;

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

export type ContentGuestRetirementSummary = {
  /** Guests `list_idle_guest_identities_with_content` named this run. */
  contentGuestCandidates: number;
  /** Retired through the account-deletion pipeline, files and Auth user gone. */
  contentGuestsRetired: number;
  /** Left alone: in use again or linked at the re-check, or already deleted. */
  contentGuestsSkipped: number;
  /**
   * Failed. A failure after the deletion began leaves the guest locked and its
   * job marked failed, which the account-deletion-resweeps job finishes.
   */
  contentGuestRetirementFailures: number;
  contentGuestBatchLimitReached: boolean;
  contentGuestTimeBudgetReached: boolean;
};

export type OperationalRetentionSummary = IdleGuestRetentionSummary & ContentGuestRetirementSummary & {
  /** Failed best-effort operations, retained in the durable job-run summary. */
  supplementaryPruneFailures: string[];
  jobRunsDeleted: number;
  rateLimitsDeleted: number;
  completionJobsDeleted: number;
  providerEventsDeleted: number;
  providerChecksDeleted: number;
  playbackDaysRolledUp: number;
  playbackMetricsDeleted: number;
  onboardingEventsDeleted: number;
  aiUsagePayloadsCleared: number;
  unreadNotificationsDeleted: number;
  expiredJobLocksDeleted: number;
  totalDeleted: number;
  /** Calls of `prune_operational_backend_data` this run made. */
  pruneBatches: number;
  /** The last batch was still full, so a backlog remains for the next run. */
  batchLimitReached: boolean;
  /** The batches stopped at the step's time mark, not at an empty batch. */
  pruneTimeBudgetReached: boolean;
  shareEventsDeleted: number;
  profileShareEventsDeleted: number;
  abandonedFreeUnlockOrdersDeleted: number;
  accountMergeTicketsDeleted: number;
  uploadByteReservationsDeleted: number;
  /** A supplementary prune's last batch was still full. */
  supplementaryBatchLimitReached: boolean;
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

/** The counters of `prune_operational_backend_data`, summed across its batches. */
const PRUNE_COUNTERS = {
  jobRunsDeleted: 'job_runs_deleted',
  rateLimitsDeleted: 'rate_limits_deleted',
  completionJobsDeleted: 'completion_jobs_deleted',
  providerEventsDeleted: 'provider_events_deleted',
  providerChecksDeleted: 'provider_checks_deleted',
  playbackDaysRolledUp: 'playback_days_rolled_up',
  playbackMetricsDeleted: 'playback_metrics_deleted',
  onboardingEventsDeleted: 'onboarding_events_deleted',
  aiUsagePayloadsCleared: 'ai_usage_payloads_cleared',
  unreadNotificationsDeleted: 'unread_notifications_deleted',
  expiredJobLocksDeleted: 'expired_job_locks_deleted',
  totalDeleted: 'total_deleted',
} as const;

type PruneCounters = Record<keyof typeof PRUNE_COUNTERS, number>;

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The user ids of a guest-listing RPC's rows, or null for any other shape. */
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

export type ContentGuestRetirementOutcome = 'retired' | 'already_deleted';

/**
 * A guest's deletion as its own request would run it, without a token to sign
 * out (an idle guest's sessions go with its Auth user): the guest guard, the
 * storage sweep, the Auth delete and the scheduled resweep. A failure after the
 * deletion began marks the job failed, which puts it in front of the
 * account-deletion-resweeps job, as the account route does.
 */
export async function retireGuestThroughAccountDeletion(
  admin: SupabaseClient,
  userId: string,
): Promise<ContentGuestRetirementOutcome> {
  const start = await startInitialAccountDeletion({ admin, userId, identityKind: 'guest' });
  if (start.status === 'already_deleted') return 'already_deleted';
  try {
    await finishInitialAccountDeletion({
      admin,
      userId,
      manifest: start.manifest,
      onNonFatalError: (message, error) => {
        logBackendError('operational_retention_content_guest_non_fatal', { userId, message, error });
      },
    });
  } catch (error) {
    try {
      await markAccountDeletionStage(admin, userId, 'failed', error);
    } catch (stageError) {
      logBackendError('operational_retention_content_guest_stage_failed', { userId, error: stageError });
    }
    throw error;
  }
  return 'retired';
}

/**
 * Retires the guests that made or uploaded something and have been unused for
 * 180 days (usage audit, 2026-11-04): `list_idle_guest_identities_with_content`
 * decides who, each is asked about again right before, and each goes down the
 * account-deletion pipeline, which also removes its files. Best-effort, like
 * the idle-guest step: it never throws, and reports what failed through
 * `onFailure`.
 */
export async function retireIdleGuestsWithContent(
  client: SupabaseClient,
  options: {
    now?: Date;
    limit?: number;
    /** Wall-clock ms after which no further guest is started. */
    deadlineMs?: number;
    clock?: () => number;
    retire?: (admin: SupabaseClient, userId: string) => Promise<ContentGuestRetirementOutcome>;
    onFailure?: (operation: string, error: unknown, userId?: string) => void;
  } = {},
): Promise<ContentGuestRetirementSummary> {
  const clock = options.clock ?? Date.now;
  const limit = Math.max(1, Math.floor(options.limit ?? IDLE_CONTENT_GUEST_RETIREMENT_BATCH_LIMIT));
  const deadlineMs = options.deadlineMs ?? clock() + IDLE_CONTENT_GUEST_RETIREMENT_TIME_BUDGET_MS;
  const retire = options.retire ?? retireGuestThroughAccountDeletion;
  const nowArgument = options.now ? { p_now: options.now.toISOString() } : {};
  const summary: ContentGuestRetirementSummary = {
    contentGuestCandidates: 0,
    contentGuestsRetired: 0,
    contentGuestsSkipped: 0,
    contentGuestRetirementFailures: 0,
    contentGuestBatchLimitReached: false,
    contentGuestTimeBudgetReached: false,
  };

  // The run's time is already spent: not even the list is read.
  if (clock() >= deadlineMs) {
    summary.contentGuestTimeBudgetReached = true;
    return summary;
  }

  let candidates: string[];
  try {
    const { data, error } = await client.rpc('list_idle_guest_identities_with_content', {
      ...nowArgument,
      p_limit: limit,
    });
    if (error) throw error;
    const ids = parseIdleGuestIds(data);
    if (!ids) throw new Error('list_idle_guest_identities_with_content answered in an unexpected shape.');
    candidates = ids.slice(0, limit);
  } catch (error) {
    options.onFailure?.('list_idle_guest_identities_with_content', error);
    return summary;
  }

  summary.contentGuestCandidates = candidates.length;
  summary.contentGuestBatchLimitReached = candidates.length >= limit;

  let consecutiveFailures = 0;
  for (const userId of candidates) {
    if (clock() >= deadlineMs) {
      summary.contentGuestTimeBudgetReached = true;
      break;
    }
    if (consecutiveFailures >= IDLE_GUEST_MAX_CONSECUTIVE_FAILURES) break;

    try {
      const recheck = await client.rpc('list_idle_guest_identities_with_content', {
        ...nowArgument,
        p_limit: 1,
        p_user_id: userId,
      });
      if (recheck.error) throw recheck.error;
      const stillIdle = parseIdleGuestIds(recheck.data);
      if (!stillIdle) throw new Error('list_idle_guest_identities_with_content answered in an unexpected shape.');
      if (!stillIdle.includes(userId)) {
        summary.contentGuestsSkipped += 1;
        consecutiveFailures = 0;
        continue;
      }

      const outcome = await retire(client, userId);
      if (outcome === 'retired') {
        summary.contentGuestsRetired += 1;
      } else {
        summary.contentGuestsSkipped += 1;
      }
      consecutiveFailures = 0;
    } catch (error) {
      // Linked to an account between the re-check and the guard: the account
      // owns what it made now, and nothing was changed.
      if (error instanceof GuestAccountLinkedError) {
        summary.contentGuestsSkipped += 1;
        consecutiveFailures = 0;
        continue;
      }
      summary.contentGuestRetirementFailures += 1;
      consecutiveFailures += 1;
      options.onFailure?.(
        error instanceof AccountDeletionNotStartedError
          ? 'start_content_guest_retirement'
          : 'retire_idle_guest_with_content',
        error,
        userId,
      );
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
    contentGuestRetirementLimit?: number;
    retireContentGuest?: (admin: SupabaseClient, userId: string) => Promise<ContentGuestRetirementOutcome>;
    clock?: () => number;
  } = {},
): Promise<OperationalRetentionSummary> {
  const clock = options.clock ?? Date.now;
  const runStartedAtMs = clock();
  const before = (mark: number) => clock() < runStartedAtMs + mark;
  const supplementaryPruneFailures: string[] = [];
  const recordFailure = (operation: string) => {
    if (!supplementaryPruneFailures.includes(operation)) supplementaryPruneFailures.push(operation);
  };

  const pruneArguments = {
    ...(options.now ? { p_now: options.now.toISOString() } : {}),
    ...(options.maxDeletesPerTable !== undefined
      ? { p_max_deletes_per_table: options.maxDeletesPerTable }
      : {}),
  };
  const counters = Object.fromEntries(
    Object.keys(PRUNE_COUNTERS).map((key) => [key, 0]),
  ) as PruneCounters;
  let pruneBatches = 0;
  let batchLimitReached = false;
  let pruneTimeBudgetReached = false;
  for (;;) {
    let data: unknown = null;
    let error: unknown = null;
    try {
      ({ data, error } = await client.rpc('prune_operational_backend_data', pruneArguments));
    } catch (failure) {
      error = failure;
    }
    if (error) {
      // The first batch failing fails the run, as it always did. A later one
      // keeps what the earlier batches did and lets the rest of the run go on.
      if (pruneBatches === 0) throw error;
      recordFailure('prune_operational_backend_data');
      logBackendError('operational_retention_supplementary_prune_failed', {
        operation: 'prune_operational_backend_data',
        batch: pruneBatches + 1,
        error,
      });
      break;
    }
    pruneBatches += 1;
    const summary = (data ?? {}) as Record<string, unknown>;
    for (const [key, column] of Object.entries(PRUNE_COUNTERS)) {
      counters[key as keyof PruneCounters] += toCount(summary[column]);
    }
    // True when a table filled its batch: a backlog remains.
    batchLimitReached = summary.batch_limit_reached === true;
    if (!batchLimitReached || pruneBatches >= OPERATIONAL_RETENTION_MAX_BATCHES) break;
    if (!before(OPERATIONAL_RETENTION_PRUNE_PHASE_END_MS)) {
      pruneTimeBudgetReached = true;
      break;
    }
  }

  // Tables the main retention function does not cover: the two append-only,
  // unbounded share telemetry ledgers, and the synthetic $0 orders a retried
  // free unlock leaves behind. All best-effort -- a failure here must not fail
  // the whole retention run. Each goes again while a batch comes back full.
  let supplementaryBatchLimitReached = false;
  async function pruneSupplementary(
    operation: string,
    args: Record<string, unknown>,
    batch: number,
    phaseEndMs: number,
  ) {
    let deleted = 0;
    for (let batches = 1; ; batches += 1) {
      let count: number;
      try {
        const result = await client.rpc(operation, args);
        if (result.error) throw result.error;
        count = toCount(result.data);
      } catch (error) {
        recordFailure(operation);
        logBackendError('operational_retention_supplementary_prune_failed', { operation, error });
        return deleted;
      }
      deleted += count;
      if (count < batch) return deleted;
      if (batches >= OPERATIONAL_RETENTION_MAX_BATCHES || !before(phaseEndMs)) {
        supplementaryBatchLimitReached = true;
        return deleted;
      }
    }
  }

  const ticketBatch = options.maxDeletesPerTable ?? SUPPLEMENTARY_PRUNE_BATCH;
  const shareEventsDeleted = await pruneSupplementary(
    'prune_post_share_events', {}, SUPPLEMENTARY_PRUNE_BATCH, OPERATIONAL_RETENTION_SUPPLEMENTARY_PHASE_END_MS,
  );
  const profileShareEventsDeleted = await pruneSupplementary(
    'prune_profile_share_events', {}, SUPPLEMENTARY_PRUNE_BATCH, OPERATIONAL_RETENTION_SUPPLEMENTARY_PHASE_END_MS,
  );
  const abandonedFreeUnlockOrdersDeleted = await pruneSupplementary(
    'prune_abandoned_free_unlock_orders', {}, SUPPLEMENTARY_PRUNE_BATCH, OPERATIONAL_RETENTION_SUPPLEMENTARY_PHASE_END_MS,
  );
  const accountMergeTicketsDeleted = await pruneSupplementary(
    'prune_account_merge_tickets', { p_limit: ticketBatch }, ticketBatch, OPERATIONAL_RETENTION_SUPPLEMENTARY_PHASE_END_MS,
  );

  // Expiry is not proof of absence. Delete/prove each unfinalized object first;
  // only rows this worker releases are eligible for the bookkeeping prune. The
  // sweep pages through candidates up to its action limit within its time, so
  // what is left of its step is its time budget.
  const uploadReclaim = await reclaimExpiredUploadReservations(client, {
    now: options.now,
    limit: options.maxDeletesPerTable ?? EXPIRED_UPLOAD_RESERVATION_RECLAIM_LIMIT,
    timeBudgetMs: Math.max(
      1_000,
      runStartedAtMs + OPERATIONAL_RETENTION_RECLAIM_PHASE_END_MS - clock(),
    ),
  });

  const uploadByteReservationsDeleted = await pruneSupplementary(
    'prune_upload_byte_reservations', { p_limit: ticketBatch }, ticketBatch, OPERATIONAL_RETENTION_RECLAIM_PHASE_END_MS,
  );

  // Last, and with whatever time is left: a guest that waits a day loses
  // nothing. Also best-effort, and each failure is named once in the summary.
  const runDeadlineMs = runStartedAtMs + OPERATIONAL_RETENTION_RUN_BUDGET_MS;
  const onGuestFailure = (operation: string, failure: unknown, userId?: string) => {
    recordFailure(operation);
    logBackendError('operational_retention_idle_guest_failed', {
      operation,
      ...(userId ? { userId } : {}),
      error: failure,
    });
  };
  const idleGuests = await deleteIdleGuestIdentities(client, {
    now: options.now,
    limit: options.idleGuestDeletionLimit ?? IDLE_GUEST_RETENTION_BATCH_LIMIT,
    deadlineMs: Math.min(clock() + IDLE_GUEST_RETENTION_TIME_BUDGET_MS, runDeadlineMs),
    clock,
    onFailure: onGuestFailure,
  });
  const contentGuests = await retireIdleGuestsWithContent(client, {
    now: options.now,
    limit: options.contentGuestRetirementLimit ?? IDLE_CONTENT_GUEST_RETIREMENT_BATCH_LIMIT,
    deadlineMs: Math.min(clock() + IDLE_CONTENT_GUEST_RETIREMENT_TIME_BUDGET_MS, runDeadlineMs),
    clock,
    ...(options.retireContentGuest ? { retire: options.retireContentGuest } : {}),
    onFailure: onGuestFailure,
  });

  return {
    supplementaryPruneFailures,
    shareEventsDeleted,
    profileShareEventsDeleted,
    abandonedFreeUnlockOrdersDeleted,
    accountMergeTicketsDeleted,
    uploadByteReservationsDeleted,
    supplementaryBatchLimitReached,
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
    ...contentGuests,
    ...counters,
    pruneBatches,
    batchLimitReached,
    pruneTimeBudgetReached,
  };
}
