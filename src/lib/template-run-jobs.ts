import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;

type RpcClient = Pick<SupabaseClient, 'rpc'>;

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

export async function pruneTemplateRunJobs(client: RpcClient): Promise<number> {
  const { data, error } = await client.rpc('prune_template_run_jobs', {
    p_retention_days: 30,
    p_limit: 500,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}
