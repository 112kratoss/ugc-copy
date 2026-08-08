import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_LIMIT = 500;
const DEFAULT_PRUNE_WINDOW_MINUTES = 5;

export const MAX_WORKFLOW_RUN_STEP_ATTEMPTS = 5;

// Deliberately lower than generation completions' 4. A workflow step can start
// a provider generation and drags the whole runner graph into memory with it,
// and until F14 splits the queues this shares one 300s invocation with every
// other due job. Raise it there, not here.
export const WORKFLOW_RUN_STEP_CONCURRENCY = 2;

// A run whose steps are all terminal but whose row still says 'processing' is
// the strand F12 exists to fix. The sweep re-enqueues work for runs older than
// this without a live job, which is what makes recovery server-side rather
// than dependent on a browser tab staying open.
export const WORKFLOW_RUN_STALL_SECONDS = 120;

type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

type DueProbeClient = Pick<SupabaseClient, 'from'>;

export type WorkflowRunStepJobStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type WorkflowRunStepJob = {
  id: string;
  run_id: string;
  canvas_id: string;
  node_id: string;
  attempt: number;
  status: WorkflowRunStepJobStatus;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type WorkflowRunStepFinishOutcome =
  | 'succeeded'
  | 'retry_scheduled'
  | 'exhausted'
  | WorkflowRunStepJobStatus
  | null;

export type WorkflowRunStepPruneOptions = {
  retentionDays?: number;
  limit?: number;
};

export async function enqueueWorkflowRunStepJob(
  client: RpcClient,
  params: { runId: string; nodeId: string; attempt?: number },
): Promise<string | null> {
  const { data, error } = await client.rpc('enqueue_workflow_run_step_job', {
    p_run_id: params.runId,
    p_node_id: params.nodeId,
    p_attempt: params.attempt ?? 1,
  });

  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export async function claimWorkflowRunStepJobs(
  client: RpcClient,
  params: { limit: number; lockedBy: string; lockTtlSeconds?: number },
): Promise<WorkflowRunStepJob[]> {
  const { data, error } = await client.rpc('claim_workflow_run_step_jobs', {
    p_limit: params.limit,
    p_locked_by: params.lockedBy,
    p_lock_ttl_seconds: params.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS,
  });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as WorkflowRunStepJob[];
}

/**
 * Returns false when the lease has been lost -- reclaimed by another worker
 * after a TTL lapse, or the job finished elsewhere. Callers should stop work
 * rather than race the new holder.
 */
export async function heartbeatWorkflowRunStepJob(
  client: RpcClient,
  params: { id: string; lockedBy: string },
): Promise<boolean> {
  const { data, error } = await client.rpc('heartbeat_workflow_run_step_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
  });

  if (error) throw error;
  return data === true;
}

export async function finishWorkflowRunStepJob(
  client: RpcClient,
  params: {
    id: string;
    lockedBy: string;
    succeeded: boolean;
    error?: string | null;
    retryDelaySeconds?: number;
    maxAttempts?: number;
  },
): Promise<WorkflowRunStepFinishOutcome> {
  const { data, error } = await client.rpc('finish_workflow_run_step_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_succeeded: params.succeeded,
    p_error: params.error ?? null,
    p_retry_delay_seconds: params.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
    p_max_attempts: params.maxAttempts ?? MAX_WORKFLOW_RUN_STEP_ATTEMPTS,
  });

  if (error) throw error;
  return typeof data === 'string' ? (data as WorkflowRunStepFinishOutcome) : null;
}

/**
 * Release a claimed job back to pending without consuming an attempt. Used when
 * a run is still legitimately waiting on a provider generation -- that is a
 * poll tick, not a failure, and charging it against the retry budget would let
 * a slow video generation exhaust itself while nothing was wrong.
 */
export async function deferWorkflowRunStepJob(
  client: RpcClient,
  params: { id: string; lockedBy: string; delaySeconds?: number },
): Promise<string | null> {
  const { data, error } = await client.rpc('defer_workflow_run_step_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_delay_seconds: params.delaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
  });

  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export async function cancelWorkflowRunStepJobs(
  client: RpcClient,
  params: { runId: string },
): Promise<number> {
  const { data, error } = await client.rpc('cancel_workflow_run_step_jobs', {
    p_run_id: params.runId,
  });

  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

export async function pruneWorkflowRunStepJobs(
  client: RpcClient,
  params: WorkflowRunStepPruneOptions = {},
): Promise<number | null> {
  const { data, error } = await client.rpc('prune_workflow_run_step_jobs', {
    p_retention_days: params.retentionDays ?? DEFAULT_RETENTION_DAYS,
    p_limit: params.limit ?? DEFAULT_PRUNE_LIMIT,
  });

  if (error) throw error;
  return typeof data === 'number' ? data : null;
}

export function getWorkflowRunStepRetryDelaySeconds(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const retryDelay = DEFAULT_RETRY_DELAY_SECONDS * (2 ** (normalizedAttempt - 1));
  return Math.min(MAX_RETRY_DELAY_SECONDS, retryDelay);
}

function hasRows(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0;
}

export async function hasDueWorkflowRunStepJobs(
  client: DueProbeClient,
  options: { nowMs?: number; lockTtlSeconds?: number } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  const lockTtlSeconds = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Workflow run step due probe time must be a valid timestamp');
  }

  if (!Number.isInteger(lockTtlSeconds) || lockTtlSeconds < 1) {
    throw new Error('Workflow run step due probe lock TTL must be a positive integer');
  }

  const nowIso = new Date(nowMs).toISOString();
  const pending = await client
    .from('workflow_run_step_jobs')
    .select('id')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .limit(1);

  if (pending.error) throw pending.error;
  if (hasRows(pending.data)) return true;

  // heartbeat_at is the live signal; locked_at covers a worker that died before
  // its first heartbeat, so the probe has to consider both or a job orphaned
  // early would never look due.
  const staleLockIso = new Date(nowMs - lockTtlSeconds * 1000).toISOString();
  const staleByHeartbeat = await client
    .from('workflow_run_step_jobs')
    .select('id')
    .eq('status', 'processing')
    .lte('heartbeat_at', staleLockIso)
    .limit(1);

  if (staleByHeartbeat.error) throw staleByHeartbeat.error;
  if (hasRows(staleByHeartbeat.data)) return true;

  const neverHeartbeat = await client
    .from('workflow_run_step_jobs')
    .select('id')
    .eq('status', 'processing')
    .is('heartbeat_at', null)
    .lte('locked_at', staleLockIso)
    .limit(1);

  if (neverHeartbeat.error) throw neverHeartbeat.error;
  return hasRows(neverHeartbeat.data);
}

/**
 * Runs still marked processing with no live job. Before F12 these were simply
 * lost -- the only thing advancing them was a process-local monitor in
 * whichever function instance served the original request, plus client polling
 * that mutated state on GET. This probe is what lets the cron adopt them.
 */
export async function findStalledWorkflowRuns(
  client: DueProbeClient,
  options: { nowMs?: number; stallSeconds?: number; limit?: number } = {},
): Promise<{ id: string; canvas_id: string }[]> {
  const nowMs = options.nowMs ?? Date.now();
  const stallSeconds = options.stallSeconds ?? WORKFLOW_RUN_STALL_SECONDS;
  const limit = options.limit ?? 25;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Workflow run stall probe time must be a valid timestamp');
  }

  if (!Number.isInteger(stallSeconds) || stallSeconds < 1) {
    throw new Error('Workflow run stall seconds must be a positive integer');
  }

  const cutoffIso = new Date(nowMs - stallSeconds * 1000).toISOString();
  const { data, error } = await client
    .from('workflow_canvas_runs')
    .select('id, canvas_id')
    .in('status', ['processing', 'awaiting_approval'])
    .lte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as { id: string; canvas_id: string }[];
}

export async function maybePruneWorkflowRunStepJobs(
  client: RpcClient,
  options: WorkflowRunStepPruneOptions & { nowMs?: number; windowMinutes?: number } = {},
): Promise<number | null> {
  const nowMs = options.nowMs ?? Date.now();
  if (!shouldPruneWorkflowRunStepJobs(nowMs, { windowMinutes: options.windowMinutes })) {
    return null;
  }

  return pruneWorkflowRunStepJobs(client, {
    retentionDays: options.retentionDays,
    limit: options.limit,
  });
}

export function shouldPruneWorkflowRunStepJobs(
  nowMs: number,
  options: { windowMinutes?: number } = {},
): boolean {
  const windowMinutes = options.windowMinutes ?? DEFAULT_PRUNE_WINDOW_MINUTES;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Workflow run step prune time must be a valid timestamp');
  }

  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 60) {
    throw new Error('Workflow run step prune window minutes must be between 1 and 60');
  }

  return new Date(nowMs).getUTCMinutes() < windowMinutes;
}
