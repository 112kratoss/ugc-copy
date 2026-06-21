import type { SupabaseClient } from '@supabase/supabase-js';

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function logBackendJobRunError(msg: string, fields: Record<string, unknown>) {
  console.error(JSON.stringify({
    level: 'error',
    msg,
    ...fields,
  }));
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
