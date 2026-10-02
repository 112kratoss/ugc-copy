import type { SupabaseClient } from '@supabase/supabase-js';

import type { TemplateRunStatus } from '@/lib/media-template-types';
import type { TemplateRunJob } from '@/lib/template-run-jobs';

type Row = Record<string, unknown>;
type DatabaseError = { code?: string; message: string };
type Answer = { data: unknown; error: DatabaseError | null };
type RunRow = { id: string; user_id: string; status: TemplateRunStatus; updated_at: string };

const UNFINISHED_RUN_STATUSES = ['queued', 'processing'];
const LIVE_JOB_STATUSES = ['pending', 'processing'];

/**
 * `template_run_jobs` and the functions that move a run's ticket through it,
 * held in memory. The clock is `Date.now()`, so a test moves time with vitest's
 * fake timers.
 *
 * `enqueue_template_run_job`, `claim_template_run_jobs`,
 * `heartbeat_template_run_job`, `defer_template_run_job`,
 * `finish_template_run_job` and `has_due_template_run_jobs` follow
 * `20260810106000_durable_template_run_jobs.sql` branch for branch. So do the
 * two triggers that migration adds: a run whose status changes to queued or
 * processing gets its ticket, and so does the run of a generation that turns
 * terminal. The client also answers the two reads the processor's sweep
 * makes: the runs in progress, then their tickets.
 * `template-run-job-exhaustion-database.test.ts` drives the same processor
 * against the real functions and tables, so a port that drifts from them
 * shows there.
 */
export function createTemplateRunJobQueue() {
  const runs = new Map<string, RunRow>();
  /** `run_id` is unique: a run has one ticket for as long as it lives. */
  const jobs = new Map<string, TemplateRunJob>();
  const now = () => new Date().toISOString();
  const secondsFromNow = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  function runOf(job: TemplateRunJob) {
    return runs.get(job.run_id)!;
  }

  function isDue(job: TemplateRunJob, lockTtlSeconds: number) {
    if (!UNFINISHED_RUN_STATUSES.includes(runOf(job).status)) return false;
    if (job.status === 'pending') return job.next_attempt_at <= now();
    if (job.status !== 'processing') return false;
    const lease = job.heartbeat_at ?? job.locked_at;
    return lease !== null && lease <= secondsFromNow(-lockTtlSeconds);
  }

  function enqueue(runId: string): string | null {
    const run = runs.get(runId);
    if (!run) throw new Error(`template run ${runId} not found`);
    if (!UNFINISHED_RUN_STATUSES.includes(run.status)) return null;

    const existing = jobs.get(runId);
    if (!existing) {
      const job: TemplateRunJob = {
        id: `job-${jobs.size + 1}`,
        run_id: run.id,
        user_id: run.user_id,
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: now(),
        locked_at: null,
        locked_by: null,
        heartbeat_at: null,
        last_error: null,
        created_at: now(),
        updated_at: now(),
        completed_at: null,
      };
      jobs.set(runId, job);
      return job.id;
    }

    // A live lease is never revoked: its worker keeps the ticket as it is.
    if (existing.status !== 'processing') {
      const wasOver = ['failed', 'cancelled', 'succeeded'].includes(existing.status);
      Object.assign(existing, {
        status: 'pending',
        attempt_count: wasOver ? 0 : existing.attempt_count,
        next_attempt_at: existing.next_attempt_at < now() ? existing.next_attempt_at : now(),
        locked_at: null,
        locked_by: null,
        heartbeat_at: null,
        last_error: null,
        completed_at: null,
      });
    }
    existing.updated_at = now();
    return existing.id;
  }

  function claim(args: Row): TemplateRunJob[] {
    const lockedBy = String(args.p_locked_by ?? '').trim();
    if (!lockedBy) throw new Error('locked_by is required');
    const lockTtlSeconds = Number(args.p_lock_ttl_seconds ?? 300);
    if (lockTtlSeconds < 1) throw new Error('lock ttl must be positive');
    const limit = Math.min(Math.max(Number(args.p_limit ?? 1), 1), 25);

    const claimed = [...jobs.values()]
      .filter((job) => isDue(job, lockTtlSeconds))
      .sort((left, right) => (
        left.next_attempt_at.localeCompare(right.next_attempt_at)
        || left.created_at.localeCompare(right.created_at)
      ))
      .slice(0, limit);
    for (const job of claimed) {
      Object.assign(job, {
        status: 'processing',
        locked_at: now(),
        locked_by: args.p_locked_by,
        heartbeat_at: now(),
        updated_at: now(),
      });
    }
    // Rows are handed out as copies, as they are over the network.
    return claimed.map((job) => ({ ...job }));
  }

  /** The ticket a worker still holds, which is the only one it may change. */
  function held(args: Row) {
    return [...jobs.values()].find((job) => (
      job.id === args.p_id && job.status === 'processing' && job.locked_by === args.p_locked_by
    )) ?? null;
  }

  function heartbeat(args: Row): boolean {
    const job = held(args);
    if (!job) return false;
    Object.assign(job, { heartbeat_at: now(), updated_at: now() });
    return true;
  }

  function defer(args: Row): boolean {
    const job = held(args);
    if (!job) return false;
    Object.assign(job, {
      status: 'pending',
      next_attempt_at: secondsFromNow(Math.max(Number(args.p_delay_seconds ?? 60), 1)),
      locked_at: null,
      locked_by: null,
      heartbeat_at: null,
      updated_at: now(),
    });
    return true;
  }

  function finish(args: Row): string | null {
    const job = held(args);
    if (!job) return [...jobs.values()].find((candidate) => candidate.id === args.p_id)?.status ?? null;
    const released = { locked_at: null, locked_by: null, heartbeat_at: null, updated_at: now() };

    if (args.p_succeeded) {
      Object.assign(job, released, { status: 'succeeded', last_error: null, completed_at: now() });
      return 'succeeded';
    }

    const lastError = String(args.p_error ?? 'Unknown error').slice(0, 2000);
    if (job.attempt_count + 1 < Math.max(Number(args.p_max_attempts ?? 5), 1)) {
      Object.assign(job, released, {
        status: 'pending',
        attempt_count: job.attempt_count + 1,
        next_attempt_at: secondsFromNow(Math.max(Number(args.p_retry_delay_seconds ?? 60), 1)),
        last_error: lastError,
      });
      return 'retry_scheduled';
    }

    Object.assign(job, released, {
      status: 'failed',
      attempt_count: job.attempt_count + 1,
      last_error: lastError,
      completed_at: now(),
    });
    return 'exhausted';
  }

  function call(fn: string, args: Row): unknown {
    switch (fn) {
      case 'enqueue_template_run_job':
        return enqueue(String(args.p_run_id));
      case 'claim_template_run_jobs':
        return claim(args);
      case 'heartbeat_template_run_job':
        return heartbeat(args);
      case 'defer_template_run_job':
        return defer(args);
      case 'finish_template_run_job':
        return finish(args);
      case 'has_due_template_run_jobs': {
        const lockTtlSeconds = Math.max(Number(args.p_lock_ttl_seconds ?? 300), 1);
        return [...jobs.values()].some((job) => isDue(job, lockTtlSeconds));
      }
      default:
        // A function nobody ported would answer whatever the test happened to need.
        throw new Error(`Unexpected database function: ${fn}`);
    }
  }

  async function rpc(fn: string, args: Row = {}): Promise<Answer> {
    try {
      return { data: call(fn, args), error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** What the next reads meet. Tests flip these between ticks. */
  const conditions = {
    /** The runs cannot be read, as a statement timeout leaves them. */
    runsUnreadable: false,
  };

  /** The reads the sweep makes: the runs in progress, then their tickets. */
  function from(table: string) {
    if (table !== 'template_runs' && table !== 'template_run_jobs') throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let order: { column: string; ascending: boolean } | null = null;
    let limit = Number.POSITIVE_INFINITY;

    const execute = (): Answer => {
      if (table === 'template_runs' && conditions.runsUnreadable) {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      const rows: Row[] = [...(table === 'template_runs' ? runs : jobs).values()]
        .filter((row) => filters.every((matches) => matches(row)));
      if (order) {
        const { column, ascending } = order;
        rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (ascending ? 1 : -1));
      }
      return { data: rows.slice(0, limit).map((row) => ({ ...row })), error: null };
    };
    const query = {
      select: () => query,
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      // Every timestamp here is an ISO string in UTC, so text order is time order.
      lt(column: string, value: string) {
        filters.push((row) => String(row[column]) < value);
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        order = { column, ascending: options?.ascending !== false };
        return query;
      },
      limit(count: number) {
        limit = count;
        return query;
      },
      then<T>(resolve: (value: Answer) => T) {
        return Promise.resolve(execute()).then(resolve);
      },
    };
    return query;
  }

  return {
    client: { rpc, from } as unknown as SupabaseClient,
    conditions,
    addRun(run: { id: string; userId: string; status: TemplateRunStatus }) {
      runs.set(run.id, { id: run.id, user_id: run.userId, status: run.status, updated_at: now() });
    },
    /**
     * Writes a run's status as the service does. A status that changes to
     * queued or processing fires `template_runs_enqueue_after_state_change`;
     * a write that leaves it as it was wakes nothing.
     */
    setRunStatus(runId: string, status: TemplateRunStatus) {
      const run = runs.get(runId);
      if (!run) throw new Error(`template run ${runId} not found`);
      const changed = run.status !== status;
      Object.assign(run, { status, updated_at: now() });
      if (changed && UNFINISHED_RUN_STATUSES.includes(status)) enqueue(runId);
    },
    /** `generations_enqueue_template_run_after_terminal`: one of the run's generations succeeded or failed. */
    generationTurnedTerminal(runId: string) {
      enqueue(runId);
    },
    run: (runId: string) => ({ ...runs.get(runId)! }),
    job: (runId: string) => {
      const job = jobs.get(runId);
      return job ? { ...job } : null;
    },
    /** Runs that are still in progress and have no ticket a worker could ever claim. */
    strandedRuns: () => [...runs.values()]
      .filter((run) => UNFINISHED_RUN_STATUSES.includes(run.status))
      .filter((run) => !LIVE_JOB_STATUSES.includes(jobs.get(run.id)?.status ?? 'none'))
      .map((run) => run.id),
  };
}

export type TemplateRunJobQueue = ReturnType<typeof createTemplateRunJobQueue>;
