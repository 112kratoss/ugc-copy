import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { jobErrorMessage } from '@/lib/job-error-message';
import {
  MAX_WORKFLOW_RUN_STEP_ATTEMPTS,
  WORKFLOW_RUN_MAX_LIFETIME_SECONDS,
  WORKFLOW_RUN_STEP_CONCURRENCY,
  claimWorkflowRunStepJobs,
  deferWorkflowRunStepJob,
  enqueueWorkflowRunStepJob,
  finishWorkflowRunStepJob,
  findStalledWorkflowRuns,
  getWorkflowRunStepRetryDelaySeconds,
  heartbeatWorkflowRunStepJob,
  type WorkflowRunStepJob,
} from '@/lib/workflow-run-jobs';
import { advanceWorkflowRunOnce, endGivenUpWorkflowRun } from '@/lib/workflow-runner';

export const WORKFLOW_RUN_STEP_BATCH_LIMIT = 10;

// Deferral cadence while a run waits on a generation. Short enough that a
// finished generation is reflected quickly, long enough that a day-long run
// costs a bounded number of ticks.
const WORKFLOW_RUN_DEFER_SECONDS = 60;
export const WORKFLOW_RUN_HEARTBEAT_INTERVAL_MS = 60_000;

export type WorkflowRunStepProcessSummary = {
  claimed: number;
  advanced: number;
  deferred: number;
  retried: number;
  exhausted: number;
  failed: number;
  adopted: number;
};

type AdvanceWorkflowRun = typeof advanceWorkflowRunOnce;
type EndGivenUpWorkflowRun = typeof endGivenUpWorkflowRun;

function isRunUnfinished(status: string | null | undefined): boolean {
  return status === 'processing';
}

/**
 * Re-enqueue tickets for runs that are still unfinished but have no live job.
 *
 * This is the half of F12 that makes recovery server-side. Before it, the only
 * things advancing a run were a module-level monitor map living in whichever
 * function instance served the original request, and a GET that mutated state
 * as a side effect of polling. A recycled instance stranded the run with
 * nothing watching, and the cron registry had no workflow entry at all.
 *
 * A run whose job has used every attempt gets no ticket. It is handed to
 * `endGivenUpWorkflowRun`, which follows the renders the run started to their
 * end and then ends it, so such a run can be met here on several sweeps while
 * a render is still going.
 */
export async function adoptStalledWorkflowRuns(params: {
  supabase: SupabaseClient;
  nowMs?: number;
  limit?: number;
  endGivenUpRun?: EndGivenUpWorkflowRun;
}): Promise<number> {
  const { supabase, nowMs = Date.now(), limit = 25, endGivenUpRun = endGivenUpWorkflowRun } = params;

  const stalled = await findStalledWorkflowRuns(supabase, { nowMs, limit });
  if (stalled.length === 0) return 0;

  // The RPC applies this exclusion before LIMIT, which prevents starvation.
  // Re-check the returned ids as a narrow race guard: a live ticket can be
  // created after the RPC snapshot but before this worker enqueues adoption.
  const runIds = stalled.map((run) => run.id);
  const { data: liveJobs, error } = await supabase
    .from('workflow_run_step_jobs')
    .select('run_id, attempt')
    .in('run_id', runIds)
    .in('status', ['pending', 'processing']);

  if (error) throw error;

  const runsWithLiveJob = new Set(
    (Array.isArray(liveJobs) ? liveJobs : []).map((job) => (job as { run_id: string }).run_id),
  );

  let adopted = 0;
  for (const run of stalled) {
    if (runsWithLiveJob.has(run.id)) continue;

    // The ticket is keyed on the run's start node, and attempt collisions are a
    // no-op at the RPC, so adopting a run twice cannot double-enqueue. A run
    // whose earlier attempts all terminated gets a fresh ticket at the next
    // free attempt number.
    try {
      const { data: usedAttempts, error: usedAttemptsError } = await supabase
        .from('workflow_run_step_jobs')
        .select('attempt, last_error')
        .eq('run_id', run.id)
        .order('attempt', { ascending: false })
        .limit(1);

      // Unread, a failed read counted as no attempts used, and a run with
      // none left was offered a ticket it already had.
      if (usedAttemptsError) throw usedAttemptsError;

      const lastJob = (Array.isArray(usedAttempts) ? usedAttempts[0] : null) as
        | { attempt: number; last_error?: string | null }
        | null
        | undefined;
      const highestAttempt = Number(lastJob?.attempt) || 0;

      if (highestAttempt >= MAX_WORKFLOW_RUN_STEP_ATTEMPTS) {
        await endGivenUpRun({ supabase, runId: run.id, nowMs, lastError: lastJob?.last_error ?? null });
        continue;
      }

      const { data: runRow } = await supabase
        .from('workflow_canvas_runs')
        .select('start_node_id')
        .eq('id', run.id)
        .maybeSingle();

      const nodeId = (runRow as { start_node_id?: string } | null)?.start_node_id;
      if (!nodeId) continue;

      await enqueueWorkflowRunStepJob(supabase, {
        runId: run.id,
        nodeId,
        attempt: highestAttempt + 1,
      });
      adopted += 1;
    } catch (error) {
      // One unadoptable run must not stop the sweep for the rest.
      logBackendError('workflow_run_adopt_failed', { error, runId: run.id });
    }
  }

  return adopted;
}

async function processOne(params: {
  supabase: SupabaseClient;
  job: WorkflowRunStepJob;
  lockedBy: string;
  nowMs: number;
  advanceRun: AdvanceWorkflowRun;
  endGivenUpRun: EndGivenUpWorkflowRun;
  summary: WorkflowRunStepProcessSummary;
}): Promise<void> {
  const { supabase, job, lockedBy, nowMs, advanceRun, endGivenUpRun, summary } = params;
  let heartbeatInFlight = false;
  let leaseLost = false;
  const heartbeatDuringAdvance = async () => {
    if (heartbeatInFlight || leaseLost) return;
    heartbeatInFlight = true;
    try {
      leaseLost = !(await heartbeatWorkflowRunStepJob(supabase, { id: job.id, lockedBy }));
    } catch (error) {
      // A transient heartbeat error must not create a second executor. Leave
      // the current attempt alone; if the process dies, normal TTL reclaim is
      // still the durable fallback.
      logBackendError('workflow_run_step_heartbeat_failed', { error, jobId: job.id });
    } finally {
      heartbeatInFlight = false;
    }
  };
  const heartbeatTimer = setInterval(() => {
    void heartbeatDuringAdvance();
  }, WORKFLOW_RUN_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    const run = await advanceRun({
      supabase,
      canvasId: job.canvas_id,
      runId: job.run_id,
    });

    // Losing the lease mid-advance means another worker has taken over. Stop
    // rather than race it to the finish call.
    const stillHeld = !leaseLost
      && await heartbeatWorkflowRunStepJob(supabase, { id: job.id, lockedBy });
    if (!stillHeld) return;

    if (isRunUnfinished(run?.status)) {
      const runAgeMs = run?.created_at ? nowMs - Date.parse(run.created_at) : 0;
      if (Number.isFinite(runAgeMs) && runAgeMs > WORKFLOW_RUN_MAX_LIFETIME_SECONDS * 1000) {
        const lifetimeError = 'Workflow run exceeded its maximum lifetime without finishing.';
        // Before the ticket is closed: if the run cannot be ended, the catch
        // below fails the ticket under the usual cap and its retry ends it.
        await endGivenUpRun({ supabase, runId: job.run_id, nowMs, lastError: lifetimeError });
        const outcome = await finishWorkflowRunStepJob(supabase, {
          id: job.id,
          lockedBy,
          succeeded: false,
          error: lifetimeError,
          retryDelaySeconds: getWorkflowRunStepRetryDelaySeconds(job.attempt),
          maxAttempts: job.attempt,
        });
        if (outcome === 'retry_scheduled') summary.retried += 1;
        else if (outcome === 'exhausted') summary.exhausted += 1;
        else summary.failed += 1;
        return;
      }

      await deferWorkflowRunStepJob(supabase, {
        id: job.id,
        lockedBy,
        delaySeconds: WORKFLOW_RUN_DEFER_SECONDS,
      });
      summary.deferred += 1;
      return;
    }

    await finishWorkflowRunStepJob(supabase, { id: job.id, lockedBy, succeeded: true });
    summary.advanced += 1;
  } catch (error) {
    const outcome = await finishWorkflowRunStepJob(supabase, {
      id: job.id,
      lockedBy,
      succeeded: false,
      error: jobErrorMessage(error),
      retryDelaySeconds: getWorkflowRunStepRetryDelaySeconds(job.attempt),
    }).catch((finishError) => {
      logBackendError('workflow_run_step_finish_failed', { error: finishError, jobId: job.id });
      return null;
    });

    if (outcome === 'retry_scheduled') summary.retried += 1;
    else if (outcome === 'exhausted') summary.exhausted += 1;
    else summary.failed += 1;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function processWorkflowRunStepJobs(params: {
  supabase: SupabaseClient;
  lockedBy: string;
  limit?: number;
  concurrency?: number;
  nowMs?: number;
  advanceRun?: AdvanceWorkflowRun;
  endGivenUpRun?: EndGivenUpWorkflowRun;
}): Promise<WorkflowRunStepProcessSummary> {
  const {
    supabase,
    lockedBy,
    limit = WORKFLOW_RUN_STEP_BATCH_LIMIT,
    concurrency = WORKFLOW_RUN_STEP_CONCURRENCY,
    nowMs = Date.now(),
    advanceRun = advanceWorkflowRunOnce,
    endGivenUpRun = endGivenUpWorkflowRun,
  } = params;

  const summary: WorkflowRunStepProcessSummary = {
    claimed: 0,
    advanced: 0,
    deferred: 0,
    retried: 0,
    exhausted: 0,
    failed: 0,
    adopted: 0,
  };

  summary.adopted = await adoptStalledWorkflowRuns({ supabase, nowMs, endGivenUpRun });

  const jobs = await claimWorkflowRunStepJobs(supabase, { limit, lockedBy });
  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  // Bounded fan-out rather than Promise.all over the whole batch: each advance
  // can start a provider generation and holds a graph in memory, and until F14
  // splits the queues this shares one 300s invocation with every other job.
  const queue = [...jobs];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      await processOne({ supabase, job, lockedBy, nowMs, advanceRun, endGivenUpRun, summary });
    }
  });

  await Promise.all(workers);
  return summary;
}
