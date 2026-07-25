import type { SupabaseClient } from '@supabase/supabase-js';

import {
  attachGenerationProviderTask,
  settleGenerationFailed,
} from '@/lib/generation-services';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';

const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;
const MAX_COMPLETION_ATTEMPTS = 5;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_LIMIT = 500;
const DEFAULT_PRUNE_WINDOW_MINUTES = 5;
const GENERATION_COMPLETION_CONCURRENCY = 4;

type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

type DueProbeClient = Pick<SupabaseClient, 'from'>;

export type GenerationCompletionPruneOptions = {
  retentionDays?: number;
  limit?: number;
};

export type GenerationCompletionAutomaticPruneOptions = GenerationCompletionPruneOptions & {
  nowMs?: number;
  windowMinutes?: number;
};

export type GenerationCompletionJob = {
  id: string;
  prediction_id: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  attempt_count: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type GenerationCompletionProcessSummary = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
};

type GenerationSyncResult = Awaited<ReturnType<typeof syncGenerationStatusByPredictionId>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getCallbackGenerationId(payload: Record<string, unknown>): string | null {
  const metadata = isRecord(payload.magicbooklet) ? payload.magicbooklet : null;
  const generationId = metadata?.callbackGenerationId;
  return typeof generationId === 'string' && generationId.trim() ? generationId.trim() : null;
}

export async function enqueueGenerationCompletionJob(
  client: RpcClient,
  params: { predictionId: string; payload: Record<string, unknown> },
): Promise<string> {
  const { data, error } = await client.rpc('enqueue_generation_completion_job', {
    p_prediction_id: params.predictionId,
    p_payload: params.payload,
  });

  if (error) throw error;
  return data as string;
}

export async function claimGenerationCompletionJobs(
  client: RpcClient,
  params: {
    limit: number;
    lockedBy: string;
    lockTtlSeconds?: number;
    predictionId?: string | null;
  },
): Promise<GenerationCompletionJob[]> {
  const { data, error } = await client.rpc('claim_generation_completion_jobs', {
    p_limit: params.limit,
    p_locked_by: params.lockedBy,
    p_lock_ttl_seconds: params.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS,
    p_prediction_id: params.predictionId ?? null,
  });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as GenerationCompletionJob[];
}

export async function finishGenerationCompletionJob(
  client: RpcClient,
  params: {
    id: string;
    lockedBy: string;
    succeeded: boolean;
    error?: string | null;
    retryDelaySeconds?: number;
  },
): Promise<string | null> {
  const { data, error } = await client.rpc('finish_generation_completion_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_succeeded: params.succeeded,
    p_error: params.error ?? null,
    p_retry_delay_seconds: params.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
  });

  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export function getGenerationCompletionRetryDelaySeconds(attemptCount: number): number {
  const normalizedAttempt = Number.isFinite(attemptCount)
    ? Math.max(1, Math.floor(attemptCount))
    : 1;
  const retryDelay = DEFAULT_RETRY_DELAY_SECONDS * (2 ** (normalizedAttempt - 1));
  return Math.min(MAX_RETRY_DELAY_SECONDS, retryDelay);
}

export async function pruneGenerationCompletionJobs(
  client: RpcClient,
  params: GenerationCompletionPruneOptions = {},
): Promise<number | null> {
  const { data, error } = await client.rpc('prune_generation_completion_jobs', {
    p_retention_days: params.retentionDays ?? DEFAULT_RETENTION_DAYS,
    p_limit: params.limit ?? DEFAULT_PRUNE_LIMIT,
  });

  if (error) throw error;
  return typeof data === 'number' ? data : null;
}

function hasRows(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0;
}

export async function hasDueGenerationCompletionJobs(
  client: DueProbeClient,
  options: { nowMs?: number; lockTtlSeconds?: number } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  const lockTtlSeconds = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Generation completion due probe time must be a valid timestamp');
  }

  if (!Number.isInteger(lockTtlSeconds) || lockTtlSeconds < 1) {
    throw new Error('Generation completion due probe lock TTL must be a positive integer');
  }

  const nowIso = new Date(nowMs).toISOString();
  const pending = await client
    .from('generation_completion_jobs')
    .select('id')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .limit(1);

  if (pending.error) throw pending.error;
  if (hasRows(pending.data)) return true;

  const staleLockIso = new Date(nowMs - lockTtlSeconds * 1000).toISOString();
  const staleProcessing = await client
    .from('generation_completion_jobs')
    .select('id')
    .eq('status', 'processing')
    .lte('locked_at', staleLockIso)
    .limit(1);

  if (staleProcessing.error) throw staleProcessing.error;
  return hasRows(staleProcessing.data);
}

export function shouldPruneGenerationCompletionJobs(
  nowMs: number,
  options: { windowMinutes?: number } = {},
): boolean {
  const windowMinutes = options.windowMinutes ?? DEFAULT_PRUNE_WINDOW_MINUTES;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Generation completion prune time must be a valid timestamp');
  }

  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 60) {
    throw new Error('Generation completion prune window minutes must be between 1 and 60');
  }

  return new Date(nowMs).getUTCMinutes() < windowMinutes;
}

export async function maybePruneGenerationCompletionJobs(
  client: RpcClient,
  options: GenerationCompletionAutomaticPruneOptions = {},
): Promise<number | null> {
  const {
    nowMs = Date.now(),
    windowMinutes,
    ...pruneOptions
  } = options;

  if (!shouldPruneGenerationCompletionJobs(nowMs, { windowMinutes })) {
    return null;
  }

  return pruneGenerationCompletionJobs(client, pruneOptions);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function isTerminalGenerationSync(result: GenerationSyncResult): boolean {
  return result.found && (result.status === 'succeeded' || result.status === 'failed');
}

function retryReason(result: GenerationSyncResult): string {
  if (!result.found) return 'Generation row not found for provider task.';
  return `Generation is still ${result.status}.`;
}

function retryDelayForJob(job: GenerationCompletionJob, explicitDelaySeconds?: number): number {
  return explicitDelaySeconds ?? getGenerationCompletionRetryDelaySeconds(job.attempt_count);
}

function isExhaustedCompletionAttempt(job: GenerationCompletionJob): boolean {
  return job.attempt_count >= MAX_COMPLETION_ATTEMPTS;
}

async function finishUnsuccessfulCompletionJob(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  job: GenerationCompletionJob;
  lockedBy: string;
  error: string;
  retryDelaySeconds?: number;
}): Promise<string | null> {
  if (isExhaustedCompletionAttempt(params.job)) {
    await settleGenerationFailed(params.creditSupabase, params.job.prediction_id);
  }

  return finishGenerationCompletionJob(params.supabase, {
    id: params.job.id,
    lockedBy: params.lockedBy,
    succeeded: false,
    error: params.error,
    retryDelaySeconds: retryDelayForJob(params.job, params.retryDelaySeconds),
  });
}

async function reattachProviderTaskFromCallbackId(
  client: SupabaseClient,
  params: { generationId: string; predictionId: string },
) {
  return attachGenerationProviderTask(client, params);
}

async function syncCompletionJobGenerationStatus(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  job: GenerationCompletionJob;
}): Promise<GenerationSyncResult> {
  const result = await syncGenerationStatusByPredictionId({
    supabase: params.supabase,
    creditSupabase: params.creditSupabase,
    predictionId: params.job.prediction_id,
    providerPayload: params.job.payload,
  });

  if (result.found) return result;

  const callbackGenerationId = getCallbackGenerationId(params.job.payload);
  if (!callbackGenerationId) return result;

  const attachStatus = await reattachProviderTaskFromCallbackId(params.supabase, {
    generationId: callbackGenerationId,
    predictionId: params.job.prediction_id,
  });

  if (attachStatus !== 'attached' && attachStatus !== 'already_attached') {
    return result;
  }

  return syncGenerationStatusByPredictionId({
    supabase: params.supabase,
    creditSupabase: params.creditSupabase,
    predictionId: params.job.prediction_id,
    providerPayload: params.job.payload,
  });
}

type GenerationCompletionJobOutcome = 'completed' | 'retried' | 'failed';

async function processGenerationCompletionJob(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  job: GenerationCompletionJob;
  lockedBy: string;
  retryDelaySeconds?: number;
}): Promise<GenerationCompletionJobOutcome> {
  let result: GenerationSyncResult | null = null;
  let failureReason: string | null = null;

  try {
    result = await syncCompletionJobGenerationStatus({
      supabase: params.supabase,
      creditSupabase: params.creditSupabase,
      job: params.job,
    });
  } catch (error) {
    failureReason = errorMessage(error);
  }

  if (failureReason) {
    const status = await finishUnsuccessfulCompletionJob({
      ...params,
      error: failureReason,
    });
    return status === 'failed' ? 'failed' : 'retried';
  }

  if (result && isTerminalGenerationSync(result)) {
    await finishGenerationCompletionJob(params.supabase, {
      id: params.job.id,
      lockedBy: params.lockedBy,
      succeeded: true,
    });
    return 'completed';
  }

  const status = await finishUnsuccessfulCompletionJob({
    ...params,
    error: result ? retryReason(result) : 'Generation completion status could not be determined.',
  });
  return status === 'failed' ? 'failed' : 'retried';
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];

  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));

  return results;
}

export async function processGenerationCompletionJobs(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  lockedBy: string;
  limit: number;
  predictionId?: string | null;
  retryDelaySeconds?: number;
}): Promise<GenerationCompletionProcessSummary> {
  const jobs = await claimGenerationCompletionJobs(params.supabase, {
    limit: params.limit,
    lockedBy: params.lockedBy,
    predictionId: params.predictionId ?? null,
  });
  const summary: GenerationCompletionProcessSummary = {
    claimed: jobs.length,
    completed: 0,
    retried: 0,
    failed: 0,
  };

  const outcomes = await mapWithConcurrency(
    jobs,
    GENERATION_COMPLETION_CONCURRENCY,
    (job) => processGenerationCompletionJob({
      supabase: params.supabase,
      creditSupabase: params.creditSupabase,
      job,
      lockedBy: params.lockedBy,
      retryDelaySeconds: params.retryDelaySeconds,
    }),
  );
  for (const outcome of outcomes) {
    summary[outcome] += 1;
  }

  return summary;
}
