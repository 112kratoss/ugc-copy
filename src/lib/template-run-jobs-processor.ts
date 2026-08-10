import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  claimTemplateRunJobs,
  deferTemplateRunJob,
  finishTemplateRunJob,
  heartbeatTemplateRunJob,
  type TemplateRunJob,
} from '@/lib/template-run-jobs';
import { syncTemplateRun } from '@/lib/template-run-service';

export const TEMPLATE_RUN_JOB_BATCH_LIMIT = 10;
export const TEMPLATE_RUN_JOB_CONCURRENCY = 2;
const TEMPLATE_RUN_DEFER_SECONDS = 60;
const TEMPLATE_RUN_HEARTBEAT_MS = 60_000;

export type TemplateRunJobSummary = {
  claimed: number;
  completed: number;
  deferred: number;
  retried: number;
  exhausted: number;
  leaseLost: number;
};

type SyncRun = typeof syncTemplateRun;

function retryDelaySeconds(attemptCount: number) {
  return Math.min(15 * 60, 60 * (2 ** Math.max(0, attemptCount)));
}

async function processOne(params: {
  client: SupabaseClient;
  job: TemplateRunJob;
  lockedBy: string;
  summary: TemplateRunJobSummary;
  syncRun: SyncRun;
}) {
  let leaseLost = false;
  let heartbeatBusy = false;
  const heartbeat = async () => {
    if (leaseLost || heartbeatBusy) return !leaseLost;
    heartbeatBusy = true;
    try {
      leaseLost = !(await heartbeatTemplateRunJob({
        client: params.client,
        id: params.job.id,
        lockedBy: params.lockedBy,
      }));
    } catch (error) {
      logBackendError('template_run_job_heartbeat_failed', { jobId: params.job.id, error });
    } finally {
      heartbeatBusy = false;
    }
    return !leaseLost;
  };
  const timer = setInterval(() => void heartbeat(), TEMPLATE_RUN_HEARTBEAT_MS);
  timer.unref?.();

  try {
    const run = await params.syncRun({
      adminClient: params.client,
      runId: params.job.run_id,
      userId: params.job.user_id,
    });

    await heartbeat();
    if (leaseLost) {
      params.summary.leaseLost += 1;
      return;
    }

    if (run.status === 'queued' || run.status === 'processing') {
      await deferTemplateRunJob({
        client: params.client,
        id: params.job.id,
        lockedBy: params.lockedBy,
        delaySeconds: TEMPLATE_RUN_DEFER_SECONDS,
      });
      params.summary.deferred += 1;
      return;
    }

    await finishTemplateRunJob({
      client: params.client,
      id: params.job.id,
      lockedBy: params.lockedBy,
      succeeded: true,
    });
    params.summary.completed += 1;
  } catch (error) {
    const outcome = await finishTemplateRunJob({
      client: params.client,
      id: params.job.id,
      lockedBy: params.lockedBy,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
      retryDelaySeconds: retryDelaySeconds(params.job.attempt_count),
    }).catch((finishError) => {
      logBackendError('template_run_job_finish_failed', { jobId: params.job.id, error: finishError });
      return null;
    });
    if (outcome === 'retry_scheduled') params.summary.retried += 1;
    else if (outcome === 'exhausted') params.summary.exhausted += 1;
  } finally {
    clearInterval(timer);
  }
}

export async function processTemplateRunJobs(params: {
  client: SupabaseClient;
  lockedBy: string;
  limit?: number;
  concurrency?: number;
  syncRun?: SyncRun;
}): Promise<TemplateRunJobSummary> {
  const jobs = await claimTemplateRunJobs({
    client: params.client,
    limit: params.limit ?? TEMPLATE_RUN_JOB_BATCH_LIMIT,
    lockedBy: params.lockedBy,
  });
  const summary: TemplateRunJobSummary = {
    claimed: jobs.length,
    completed: 0,
    deferred: 0,
    retried: 0,
    exhausted: 0,
    leaseLost: 0,
  };
  const queue = [...jobs];
  const workerCount = Math.min(
    Math.max(1, params.concurrency ?? TEMPLATE_RUN_JOB_CONCURRENCY),
    Math.max(1, jobs.length),
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      await processOne({
        client: params.client,
        job,
        lockedBy: params.lockedBy,
        summary,
        syncRun: params.syncRun ?? syncTemplateRun,
      });
    }
  }));
  return summary;
}
