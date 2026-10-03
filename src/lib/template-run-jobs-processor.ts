import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import { isRecord } from '@/lib/media-template-types';
import {
  TEMPLATE_RUN_GIVE_UP_SECONDS,
  claimTemplateRunJobs,
  deferTemplateRunJob,
  enqueueTemplateRunJob,
  findStrandedTemplateRuns,
  finishTemplateRunJob,
  heartbeatTemplateRunJob,
  type TemplateRunJob,
} from '@/lib/template-run-jobs';
import { abandonTemplateRun, syncTemplateRun } from '@/lib/template-run-service';

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
  /** Runs that had no live ticket and were given one again. */
  adopted: number;
  /** Runs that had no live ticket and were ended, with a word to the person. */
  abandoned: number;
};

type SyncRun = typeof syncTemplateRun;
type AbandonRun = typeof abandonTemplateRun;

function retryDelaySeconds(attemptCount: number) {
  return Math.min(15 * 60, 60 * (2 ** Math.max(0, attemptCount)));
}

/** A database error reaches here as PostgREST's plain object, which `String` turns into "[object Object]". */
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * Takes up the runs still in progress that have no live ticket.
 *
 * A run that had a pass which worked within the give-up time gets its ticket
 * written again: whatever spent the ticket may be over, and the run carries
 * on from where it is. A run that has gone the give-up time without one is
 * ended and the person is told, so a run that can never finish does not show
 * as running for good.
 *
 * The clock is the run's `updated_at`. Every pass that works moves it when it
 * writes the run's progress, and so does everything the person does to the
 * run. A pass that fails before that leaves it where it was.
 *
 * Canvas runs have the same sweep in `adoptStalledWorkflowRuns`.
 */
export async function adoptStrandedTemplateRuns(params: {
  client: SupabaseClient;
  nowMs?: number;
  abandonRun?: AbandonRun;
}): Promise<Pick<TemplateRunJobSummary, 'adopted' | 'abandoned'>> {
  const nowMs = params.nowMs ?? Date.now();
  const giveUpMs = nowMs - TEMPLATE_RUN_GIVE_UP_SECONDS * 1000;
  const summary = { adopted: 0, abandoned: 0 };

  for (const run of await findStrandedTemplateRuns(params.client, { nowMs })) {
    // One run that cannot be taken up must not stop the sweep for the rest.
    try {
      if (Date.parse(String(run.updated_at)) < giveUpMs) {
        const ended = await (params.abandonRun ?? abandonTemplateRun)({
          client: params.client,
          runId: run.id,
          userId: run.user_id,
          idleBefore: new Date(giveUpMs).toISOString(),
          lastError: run.last_error,
        });
        if (ended) summary.abandoned += 1;
      } else if (await enqueueTemplateRunJob(params.client, run.id)) {
        logBackendWarning('template_run_adopted', { runId: run.id, lastError: run.last_error });
        summary.adopted += 1;
      }
    } catch (error) {
      logBackendError('template_run_adopt_failed', { runId: run.id, error });
    }
  }
  return summary;
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
      error: errorMessage(error),
      retryDelaySeconds: retryDelaySeconds(params.job.attempt_count),
    }).catch((finishError) => {
      logBackendError('template_run_job_finish_failed', { jobId: params.job.id, error: finishError });
      return null;
    });
    // The ticket keeps only the last pass's error, and a ticket written again loses that too.
    logBackendError('template_run_pass_failed', {
      jobId: params.job.id,
      runId: params.job.run_id,
      outcome,
      error,
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
  nowMs?: number;
  syncRun?: SyncRun;
  abandonRun?: AbandonRun;
}): Promise<TemplateRunJobSummary> {
  // Before the claim, so a run given its ticket back is worked on in this call.
  // A sweep that fails must not cost the tickets that are due their turn.
  const swept = await adoptStrandedTemplateRuns({
    client: params.client,
    nowMs: params.nowMs,
    abandonRun: params.abandonRun,
  }).catch((error) => {
    logBackendError('template_run_sweep_failed', { error });
    return { adopted: 0, abandoned: 0 };
  });
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
    ...swept,
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
