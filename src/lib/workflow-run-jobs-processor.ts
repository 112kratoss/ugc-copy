import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
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
import { advanceWorkflowRunOnce } from '@/lib/workflow-runner';

export const WORKFLOW_RUN_STEP_BATCH_LIMIT = 10;

// How long a run may stay unfinished before the queue stops polling it. The
// generation reaper in the generation-completions job is what eventually closes
// an orphaned provider task, which then hydrates the workflow step as failed --
// so this only has to outlast the slowest legitimate generation, not guess at
// terminal state on the run's behalf.
export const WORKFLOW_RUN_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

// Deferral cadence while a run waits on a generation. Short enough that a
// finished generation is reflected quickly, long enough that a day-long run
// costs a bounded number of ticks.
const WORKFLOW_RUN_DEFER_SECONDS = 60;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunUnfinished(status: string | null | undefined): boolean {
  return status === 'processing' || status === 'awaiting_approval';
}

/**
 * Re-enqueue tickets for runs that are still unfinished but have no live job.
 *
 * This is the half of F12 that makes recovery server-side. Before it, the only
 * things advancing a run were a module-level monitor map living in whichever
 * function instance served the original request, and a GET that mutated state
 * as a side effect of polling. A recycled instance stranded the run with
 * nothing watching, and the cron registry had no workflow entry at all.
 */
export async function adoptStalledWorkflowRuns(params: {
  supabase: SupabaseClient;
  nowMs?: number;
  limit?: number;
}): Promise<number> {
  const { supabase, nowMs = Date.now(), limit = 25 } = params;

  const stalled = await findStalledWorkflowRuns(supabase, { nowMs, limit });
  if (stalled.length === 0) return 0;

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
      const { data: usedAttempts } = await supabase
        .from('workflow_run_step_jobs')
        .select('attempt')
        .eq('run_id', run.id)
        .order('attempt', { ascending: false })
        .limit(1);

      const highestAttempt = Array.isArray(usedAttempts) && usedAttempts.length > 0
        ? Number((usedAttempts[0] as { attempt: number }).attempt) || 0
        : 0;

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
  summary: WorkflowRunStepProcessSummary;
}): Promise<void> {
  const { supabase, job, lockedBy, nowMs, advanceRun, summary } = params;

  try {
    const run = await advanceRun({
      supabase,
      canvasId: job.canvas_id,
      runId: job.run_id,
    });

    // Losing the lease mid-advance means another worker has taken over. Stop
    // rather than race it to the finish call.
    const stillHeld = await heartbeatWorkflowRunStepJob(supabase, { id: job.id, lockedBy });
    if (!stillHeld) return;

    if (isRunUnfinished(run?.status)) {
      const runAgeMs = run?.created_at ? nowMs - Date.parse(run.created_at) : 0;
      if (Number.isFinite(runAgeMs) && runAgeMs > WORKFLOW_RUN_MAX_LIFETIME_SECONDS * 1000) {
        const outcome = await finishWorkflowRunStepJob(supabase, {
          id: job.id,
          lockedBy,
          succeeded: false,
          error: 'Workflow run exceeded its maximum lifetime without finishing.',
          retryDelaySeconds: getWorkflowRunStepRetryDelaySeconds(job.attempt),
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
      error: errorMessage(error),
      retryDelaySeconds: getWorkflowRunStepRetryDelaySeconds(job.attempt),
    }).catch((finishError) => {
      logBackendError('workflow_run_step_finish_failed', { error: finishError, jobId: job.id });
      return null;
    });

    if (outcome === 'retry_scheduled') summary.retried += 1;
    else if (outcome === 'exhausted') summary.exhausted += 1;
    else summary.failed += 1;
  }
}

export async function processWorkflowRunStepJobs(params: {
  supabase: SupabaseClient;
  lockedBy: string;
  limit?: number;
  concurrency?: number;
  nowMs?: number;
  advanceRun?: AdvanceWorkflowRun;
}): Promise<WorkflowRunStepProcessSummary> {
  const {
    supabase,
    lockedBy,
    limit = WORKFLOW_RUN_STEP_BATCH_LIMIT,
    concurrency = WORKFLOW_RUN_STEP_CONCURRENCY,
    nowMs = Date.now(),
    advanceRun = advanceWorkflowRunOnce,
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

  summary.adopted = await adoptStalledWorkflowRuns({ supabase, nowMs });

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
      await processOne({ supabase, job, lockedBy, nowMs, advanceRun, summary });
    }
  });

  await Promise.all(workers);
  return summary;
}
