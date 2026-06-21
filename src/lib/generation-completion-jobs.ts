import type { SupabaseClient } from '@supabase/supabase-js';

import { syncGenerationStatusByPredictionId } from '@/lib/generation-services';

const DEFAULT_LOCK_TTL_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_LIMIT = 500;
const DEFAULT_PRUNE_WINDOW_MINUTES = 5;

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

async function reattachProviderTaskFromCallbackId(
  client: SupabaseClient,
  params: { generationId: string; predictionId: string },
) {
  const { error } = await client
    .from('generations')
    .update({
      prediction_id: params.predictionId,
      status: 'processing',
    })
    .eq('id', params.generationId)
    .is('prediction_id', null);

  if (error) throw error;
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

  await reattachProviderTaskFromCallbackId(params.supabase, {
    generationId: callbackGenerationId,
    predictionId: params.job.prediction_id,
  });

  return syncGenerationStatusByPredictionId({
    supabase: params.supabase,
    creditSupabase: params.creditSupabase,
    predictionId: params.job.prediction_id,
    providerPayload: params.job.payload,
  });
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

  for (const job of jobs) {
    try {
      const result = await syncCompletionJobGenerationStatus({
        supabase: params.supabase,
        creditSupabase: params.creditSupabase,
        job,
      });

      if (isTerminalGenerationSync(result)) {
        await finishGenerationCompletionJob(params.supabase, {
          id: job.id,
          lockedBy: params.lockedBy,
          succeeded: true,
        });
        summary.completed += 1;
      } else {
        const status = await finishGenerationCompletionJob(params.supabase, {
          id: job.id,
          lockedBy: params.lockedBy,
          succeeded: false,
          error: retryReason(result),
          retryDelaySeconds: params.retryDelaySeconds,
        });
        if (status === 'failed') summary.failed += 1;
        else summary.retried += 1;
      }
    } catch (error) {
      const status = await finishGenerationCompletionJob(params.supabase, {
        id: job.id,
        lockedBy: params.lockedBy,
        succeeded: false,
        error: errorMessage(error),
        retryDelaySeconds: params.retryDelaySeconds,
      });
      if (status === 'failed') summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}
