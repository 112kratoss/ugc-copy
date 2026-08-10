/**
 * Operational-data retention sweep.
 *
 * Thin wrapper over the `prune_operational_backend_data` RPC. All retention
 * policy lives in the database function so the windows are enforced in one
 * place and cannot drift between callers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OperationalRetentionSummary = {
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
  uploadByteReservationsDeleted: number;
};

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function pruneOperationalBackendData(
  client: Pick<SupabaseClient, 'rpc'>,
  options: { now?: Date; maxDeletesPerTable?: number } = {},
): Promise<OperationalRetentionSummary> {
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
  let shareEventsDeleted = 0;
  let profileShareEventsDeleted = 0;
  let abandonedFreeUnlockOrdersDeleted = 0;
  let uploadByteReservationsDeleted = 0;

  const shareResult = await client.rpc('prune_post_share_events', {});
  if (!shareResult.error) {
    shareEventsDeleted = toCount(shareResult.data);
  }

  const profileShareResult = await client.rpc('prune_profile_share_events', {});
  if (!profileShareResult.error) {
    profileShareEventsDeleted = toCount(profileShareResult.data);
  }

  const freeUnlockResult = await client.rpc('prune_abandoned_free_unlock_orders', {});
  if (!freeUnlockResult.error) {
    abandonedFreeUnlockOrdersDeleted = toCount(freeUnlockResult.data);
  }

  const uploadReservationResult = await client.rpc('prune_upload_byte_reservations', {
    p_limit: options.maxDeletesPerTable ?? 5000,
  });
  if (!uploadReservationResult.error) {
    uploadByteReservationsDeleted = toCount(uploadReservationResult.data);
  }

  return {
    shareEventsDeleted,
    profileShareEventsDeleted,
    abandonedFreeUnlockOrdersDeleted,
    uploadByteReservationsDeleted,
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
