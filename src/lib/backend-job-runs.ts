import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendEvent } from '@/lib/backend-logger';

const DEFAULT_RETENTION_DAYS = 45;
const DEFAULT_PRUNE_LIMIT = 500;
const DEFAULT_PRUNE_WINDOW_MINUTES = 5;

export type BackendJobRunHandle = {
  id: string;
  name: string;
  route: string;
  requestId: string;
  lockOwner: string;
  startedAtMs: number;
};

export type BackendJobRunStartOptions = {
  name: string;
  route: string;
  requestId: string;
  lockOwner: string;
  startedAtMs: number;
  metadata?: Record<string, unknown>;
};

export type BackendJobRunFinishOptions =
  | {
      status: 'succeeded';
      finishedAtMs: number;
      summary?: unknown;
    }
  | {
      status: 'skipped';
      finishedAtMs: number;
      skipReason: string;
      summary?: unknown;
    }
  | {
      status: 'failed';
      finishedAtMs: number;
      errorMessage: string;
      summary?: unknown;
    };

export type BackendJobRunPruneOptions = {
  retentionDays?: number;
  limit?: number;
};

export type BackendJobRunAutomaticPruneOptions = BackendJobRunPruneOptions & {
  nowMs?: number;
  windowMinutes?: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function logBackendJobRunError(msg: string, fields: Record<string, unknown>) {
  logBackendEvent('error', msg, fields);
}

export async function startBackendJobRun(
  client: SupabaseClient,
  options: BackendJobRunStartOptions,
): Promise<BackendJobRunHandle | null> {
  const { data, error } = await client
    .from('backend_job_runs')
    .insert({
      job_name: options.name,
      route: options.route,
      request_id: options.requestId,
      lock_owner: options.lockOwner,
      status: 'started',
      started_at: new Date(options.startedAtMs).toISOString(),
      metadata: options.metadata ?? {},
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    logBackendJobRunError('backend_job_run_start_failed', {
      job: options.name,
      route: options.route,
      requestId: options.requestId,
      error: error ? errorMessage(error) : 'Missing inserted job run id',
    });
    return null;
  }

  return {
    id: data.id,
    name: options.name,
    route: options.route,
    requestId: options.requestId,
    lockOwner: options.lockOwner,
    startedAtMs: options.startedAtMs,
  };
}

export async function finishBackendJobRun(
  client: SupabaseClient,
  run: BackendJobRunHandle | null,
  options: BackendJobRunFinishOptions,
): Promise<void> {
  if (!run) return;

  const finishedAtMs = Math.max(options.finishedAtMs, run.startedAtMs);
  const update: Record<string, unknown> = {
    status: options.status,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - run.startedAtMs,
    updated_at: new Date(finishedAtMs).toISOString(),
    summary: options.summary ?? null,
  };

  if (options.status === 'skipped') {
    update.skip_reason = options.skipReason;
  } else if (options.status === 'failed') {
    update.error_message = options.errorMessage;
  }

  const { error } = await client
    .from('backend_job_runs')
    .update(update)
    .eq('id', run.id);

  if (error) {
    logBackendJobRunError('backend_job_run_finish_failed', {
      job: run.name,
      route: run.route,
      requestId: run.requestId,
      runId: run.id,
      status: options.status,
      error: errorMessage(error),
    });
  }
}

export async function pruneBackendJobRuns(
  client: SupabaseClient,
  options: BackendJobRunPruneOptions = {},
): Promise<number | null> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const limit = options.limit ?? DEFAULT_PRUNE_LIMIT;

  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('Backend job run retention days must be between 1 and 3650');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error('Backend job run prune limit must be between 1 and 10000');
  }

  const { data, error } = await client.rpc('prune_backend_job_runs', {
    p_retention_days: retentionDays,
    p_limit: limit,
  });

  if (error) {
    logBackendJobRunError('backend_job_run_prune_failed', {
      retentionDays,
      limit,
      error: errorMessage(error),
    });
    return null;
  }

  return typeof data === 'number' ? data : null;
}

export function shouldPruneBackendJobRuns(
  nowMs: number,
  options: { windowMinutes?: number } = {},
): boolean {
  const windowMinutes = options.windowMinutes ?? DEFAULT_PRUNE_WINDOW_MINUTES;

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Backend job run prune time must be a valid timestamp');
  }

  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 60) {
    throw new Error('Backend job run prune window minutes must be between 1 and 60');
  }

  return new Date(nowMs).getUTCMinutes() < windowMinutes;
}

export async function maybePruneBackendJobRuns(
  client: SupabaseClient,
  options: BackendJobRunAutomaticPruneOptions = {},
): Promise<number | null> {
  const {
    nowMs = Date.now(),
    windowMinutes,
    ...pruneOptions
  } = options;

  if (!shouldPruneBackendJobRuns(nowMs, { windowMinutes })) {
    return null;
  }

  return pruneBackendJobRuns(client, pruneOptions);
}
