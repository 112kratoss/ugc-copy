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

  return {
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
