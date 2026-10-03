import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const UNFINISHED_RUN_STATUSES = ['queued', 'processing'];
const LIVE_JOB_STATUSES = new Set(['pending', 'processing']);

// How long a run may sit in progress with no live ticket before the sweep
// takes it up. It only has to outlast a pass that is letting its ticket go.
export const TEMPLATE_RUN_STALL_SECONDS = 120;

// How long a run with no live ticket may go without one pass of the worker
// that worked. Within it the run is picked up again, which is what a fault
// that passes needs. Past it the run is ended and the person is told, so a
// run that can never finish does not show as running for good.
export const TEMPLATE_RUN_GIVE_UP_SECONDS = 30 * 60;

type RpcClient = Pick<SupabaseClient, 'rpc'>;
type TableClient = Pick<SupabaseClient, 'from'>;

export type TemplateRunJob = {
  id: string;
  run_id: string;
  user_id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  attempt_count: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export async function enqueueTemplateRunJob(client: RpcClient, runId: string): Promise<string | null> {
  const { data, error } = await client.rpc('enqueue_template_run_job', { p_run_id: runId });
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export async function claimTemplateRunJobs(params: {
  client: RpcClient;
  limit: number;
  lockedBy: string;
  lockTtlSeconds?: number;
}): Promise<TemplateRunJob[]> {
  const { data, error } = await params.client.rpc('claim_template_run_jobs', {
    p_limit: params.limit,
    p_locked_by: params.lockedBy,
    p_lock_ttl_seconds: params.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as TemplateRunJob[];
}

export async function heartbeatTemplateRunJob(params: {
  client: RpcClient;
  id: string;
  lockedBy: string;
}): Promise<boolean> {
  const { data, error } = await params.client.rpc('heartbeat_template_run_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
  });
  if (error) throw error;
  return data === true;
}

export async function deferTemplateRunJob(params: {
  client: RpcClient;
  id: string;
  lockedBy: string;
  delaySeconds?: number;
}): Promise<boolean> {
  const { data, error } = await params.client.rpc('defer_template_run_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_delay_seconds: params.delaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
  });
  if (error) throw error;
  return data === true;
}

export async function finishTemplateRunJob(params: {
  client: RpcClient;
  id: string;
  lockedBy: string;
  succeeded: boolean;
  error?: string | null;
  retryDelaySeconds?: number;
  maxAttempts?: number;
}): Promise<string | null> {
  const { data, error } = await params.client.rpc('finish_template_run_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_succeeded: params.succeeded,
    p_error: params.error ?? null,
    p_retry_delay_seconds: params.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
    p_max_attempts: params.maxAttempts ?? 5,
  });
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export async function hasDueTemplateRunJobs(client: RpcClient): Promise<boolean> {
  const { data, error } = await client.rpc('has_due_template_run_jobs', {
    p_lock_ttl_seconds: DEFAULT_LOCK_TTL_SECONDS,
  });
  if (error) throw error;
  return data === true;
}

export type StrandedTemplateRun = {
  id: string;
  user_id: string;
  /** When a pass of the worker last got as far as writing the run, or the person last acted on it. */
  updated_at: string;
  /** What the last pass failed with, when failed passes are what spent the ticket. */
  last_error: string | null;
};

/**
 * Runs still in progress that no worker will ever pick up: their ticket is
 * spent (five failed passes), was closed by a pass that had read the run a
 * moment before the person acted on it, or is gone. Nothing else writes such
 * a run a ticket. A ticket is written when the run's status changes, when one
 * of its generations turns terminal and when the person acts, and a run that
 * is waiting on none of those is left where it is.
 *
 * A ticket that is pending or processing is live however old it is: a lease
 * its worker let lapse is taken over by `claim_template_run_jobs`.
 */
export async function findStrandedTemplateRuns(
  client: TableClient,
  options: { nowMs?: number; stallSeconds?: number; limit?: number } = {},
): Promise<StrandedTemplateRun[]> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.stallSeconds ?? TEMPLATE_RUN_STALL_SECONDS) * 1000;

  // Oldest first. A stranded run's `updated_at` stands still, so it rises to
  // the front while the runs a worker is still passing over keep moving back:
  // the limit, applied before the tickets are read, cannot starve it.
  const { data: runs, error } = await client
    .from('template_runs')
    .select('id, user_id, updated_at')
    .in('status', UNFINISHED_RUN_STATUSES)
    .lt('updated_at', new Date(cutoffMs).toISOString())
    .order('updated_at', { ascending: true })
    .limit(options.limit ?? 25);
  if (error) throw error;
  const candidates = (runs ?? []) as Array<Omit<StrandedTemplateRun, 'last_error'>>;
  if (!candidates.length) return [];

  const { data: jobs, error: jobsError } = await client
    .from('template_run_jobs')
    .select('run_id, status, updated_at, last_error')
    .in('run_id', candidates.map((run) => run.id));
  if (jobsError) throw jobsError;
  const tickets = new Map(((jobs ?? []) as Array<{
    run_id: string;
    status: TemplateRunJob['status'];
    updated_at: string;
    last_error: string | null;
  }>).map((job) => [job.run_id, job]));

  return candidates.flatMap((run) => {
    const ticket = tickets.get(run.id);
    if (ticket && (LIVE_JOB_STATUSES.has(ticket.status) || Date.parse(String(ticket.updated_at)) >= cutoffMs)) {
      return [];
    }
    return [{ ...run, last_error: ticket?.status === 'failed' ? ticket.last_error : null }];
  });
}

export async function pruneTemplateRunJobs(client: RpcClient): Promise<number> {
  const { data, error } = await client.rpc('prune_template_run_jobs', {
    p_retention_days: 30,
    p_limit: 500,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}
