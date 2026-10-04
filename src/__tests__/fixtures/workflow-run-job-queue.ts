import type { WorkflowRunStepJob } from '@/lib/workflow-run-jobs';

type Row = Record<string, unknown>;
type RunRow = { id: string; canvas_id: string; status: string; created_at: string };

const LIVE_JOB_STATUSES = ['pending', 'processing'];

/**
 * `workflow_run_step_jobs` and the functions that move a canvas run's tickets
 * through it, held in memory. The clock is the caller's, so a test moves time
 * by moving it.
 *
 * `enqueue_workflow_run_step_job`, `claim_workflow_run_step_jobs`,
 * `heartbeat_workflow_run_step_job`, `finish_workflow_run_step_job` and
 * `defer_workflow_run_step_job` follow `20260808160000_workflow_run_durability.sql`
 * branch for branch, and `list_stalled_workflow_runs_without_live_jobs` follows
 * `20260810102000_harden_workflow_stalled_adoption.sql`. A retry is a new row
 * at the next attempt, as it is there, so the tickets a run has used are
 * counted over its whole life.
 * `workflow-run-lifecycle-database.test.ts` drives the same processor against
 * the real functions and tables, so a port that drifts from them shows there.
 */
export function createWorkflowRunJobQueue(options: {
  /** The runs the tickets belong to, read each time they are needed. */
  runs: () => RunRow[];
  /** The database's `now()`, in milliseconds. */
  now: () => number;
}) {
  const jobs: WorkflowRunStepJob[] = [];
  const at = (seconds = 0) => new Date(options.now() + seconds * 1000).toISOString();
  const text = (value: unknown) => String(value ?? '').trim();

  function existing(runId: unknown, nodeId: string, attempt: number) {
    return jobs.find((job) => job.run_id === runId && job.node_id === nodeId && job.attempt === attempt);
  }

  function insertPending(run: Pick<RunRow, 'id' | 'canvas_id'>, nodeId: string, attempt: number, dueInSeconds: number) {
    const job: WorkflowRunStepJob = {
      id: `job-${jobs.length + 1}`,
      run_id: run.id,
      canvas_id: run.canvas_id,
      node_id: nodeId,
      attempt,
      status: 'pending',
      next_attempt_at: at(dueInSeconds),
      locked_at: null,
      locked_by: null,
      heartbeat_at: null,
      last_error: null,
      created_at: at(),
      updated_at: at(),
      completed_at: null,
    };
    jobs.push(job);
    return job;
  }

  function held(args: Row) {
    const lockedBy = text(args.p_locked_by);
    if (!lockedBy) throw new Error('locked_by is required');
    return jobs.find((job) => job.id === args.p_id && job.status === 'processing' && job.locked_by === lockedBy);
  }

  const statusOf = (id: unknown) => jobs.find((job) => job.id === id)?.status ?? null;
  const release = { locked_at: null, locked_by: null, heartbeat_at: null };

  const functions: Record<string, (args: Row) => unknown> = {
    enqueue_workflow_run_step_job(args) {
      const nodeId = text(args.p_node_id);
      const attempt = Number(args.p_attempt ?? 1);
      if (!args.p_run_id) throw new Error('run_id is required');
      if (!nodeId) throw new Error('node_id is required');
      if (!(attempt >= 1)) throw new Error('attempt must be at least 1');
      const run = options.runs().find((candidate) => candidate.id === args.p_run_id);
      if (!run) throw new Error(`workflow run ${String(args.p_run_id)} not found`);

      // Already enqueued: the caller asked for this attempt to exist, and it does.
      return (existing(run.id, nodeId, attempt) ?? insertPending(run, nodeId, attempt, 0)).id;
    },

    claim_workflow_run_step_jobs(args) {
      const lockedBy = text(args.p_locked_by);
      if (!lockedBy) throw new Error('locked_by is required');
      const lockTtlSeconds = Number(args.p_lock_ttl_seconds ?? 300);
      if (lockTtlSeconds < 1) throw new Error('lock ttl must be positive');
      const limit = Math.min(Math.max(Number(args.p_limit ?? 1), 1), 50);

      const claimed = jobs
        .filter((job) => {
          if (job.status === 'pending') return job.next_attempt_at <= at();
          if (job.status !== 'processing') return false;
          const lease = job.heartbeat_at ?? job.locked_at;
          return lease !== null && lease <= at(-lockTtlSeconds);
        })
        .sort((left, right) => (
          left.next_attempt_at.localeCompare(right.next_attempt_at)
          || left.created_at.localeCompare(right.created_at)
        ))
        .slice(0, limit);
      for (const job of claimed) {
        Object.assign(job, {
          status: 'processing',
          locked_at: at(),
          locked_by: lockedBy,
          heartbeat_at: at(),
          updated_at: at(),
        });
      }
      // Rows are handed out as copies, as they are over the network.
      return claimed.map((job) => ({ ...job }));
    },

    heartbeat_workflow_run_step_job(args) {
      const job = held(args);
      if (!job) return false;
      Object.assign(job, { heartbeat_at: at(), updated_at: at() });
      return true;
    },

    finish_workflow_run_step_job(args) {
      const retryDelaySeconds = Number(args.p_retry_delay_seconds ?? 60);
      const maxAttempts = Number(args.p_max_attempts ?? 5);
      if (retryDelaySeconds < 1) throw new Error('retry delay must be positive');
      if (maxAttempts < 1) throw new Error('max attempts must be positive');
      const job = held(args);
      // Lease lost or already finished: the state the winning worker recorded.
      if (!job) return statusOf(args.p_id);

      const succeeded = args.p_succeeded === true;
      Object.assign(job, release, {
        status: succeeded ? 'succeeded' : 'failed',
        last_error: succeeded ? null : String(args.p_error ?? 'Unknown error').slice(0, 2000),
        completed_at: at(),
        updated_at: at(),
      });
      if (succeeded) return 'succeeded';
      if (job.attempt >= maxAttempts) return 'exhausted';

      // A retry is a new row, so every attempt keeps its own error and timing.
      if (!existing(job.run_id, job.node_id, job.attempt + 1)) {
        insertPending({ id: job.run_id, canvas_id: job.canvas_id }, job.node_id, job.attempt + 1, retryDelaySeconds);
      }
      return 'retry_scheduled';
    },

    defer_workflow_run_step_job(args) {
      const delaySeconds = Number(args.p_delay_seconds ?? 60);
      if (delaySeconds < 1) throw new Error('defer delay must be positive');
      const job = held(args);
      if (!job) return statusOf(args.p_id);

      Object.assign(job, release, { status: 'pending', next_attempt_at: at(delaySeconds), updated_at: at() });
      return 'deferred';
    },

    list_stalled_workflow_runs_without_live_jobs(args) {
      const createdBefore = String(args.p_created_before ?? '');
      if (!createdBefore) throw new Error('created_before is required');
      const limit = Number(args.p_limit ?? 25);
      if (!(limit >= 1 && limit <= 100)) throw new Error('limit must be between 1 and 100');

      return options.runs()
        .filter((run) => (
          run.status === 'processing'
          && Date.parse(run.created_at) <= Date.parse(createdBefore)
          && !jobs.some((job) => job.run_id === run.id && LIVE_JOB_STATUSES.includes(job.status))
        ))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((run) => ({ id: run.id, canvas_id: run.canvas_id }));
    },
  };

  return {
    /** Every ticket there is, oldest first: the rows of `workflow_run_step_jobs`. */
    jobs,
    handlesRpc: (name: string) => Object.hasOwn(functions, name),
    /** Answers as PostgREST does: a function that raises is an error on the reply, never a rejection. */
    rpc(name: string, args: Row = {}) {
      try {
        return { data: functions[name](args), error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

export type WorkflowRunJobQueue = ReturnType<typeof createWorkflowRunJobQueue>;
