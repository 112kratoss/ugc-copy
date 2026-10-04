import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logBackendError } from '@/lib/backend-logger';
import {
  WORKFLOW_RUN_MAX_LIFETIME_SECONDS,
  findStalledWorkflowRuns,
  getWorkflowRunStepRetryDelaySeconds,
  hasDueWorkflowRunStepJobs,
  shouldPruneWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs';
import {
  WORKFLOW_RUN_HEARTBEAT_INTERVAL_MS,
  adoptStalledWorkflowRuns,
  processWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs-processor';

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: vi.fn(),
}));

type QueryResult = { data: unknown; error: unknown };

function makeQuery(result: QueryResult) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'lte', 'eq', 'is', 'order', 'limit']) {
    query[method] = () => query;
  }
  query.maybeSingle = async () => result;
  query.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

type FakeClientOptions = {
  stalledRuns?: unknown[];
  liveJobs?: unknown[];
  highestAttempt?: unknown[];
  /** What the database answers the read of a run's used attempts with, in place of rows. */
  highestAttemptError?: unknown;
  runRow?: unknown;
  claimed?: unknown[];
  heartbeat?: boolean;
  duePending?: unknown[];
};

function createFakeClient(options: FakeClientOptions = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const runUpdates: Record<string, unknown>[] = [];

  const client = {
    rpcCalls,
    runUpdates,
    from(table: string) {
      return {
        select(columns: string) {
          // Route by projection -- each probe in the processor selects a
          // distinct column list, so this stays unambiguous.
          if (columns === 'id, canvas_id') return makeQuery({ data: options.stalledRuns ?? [], error: null });
          if (columns === 'run_id, attempt') return makeQuery({ data: options.liveJobs ?? [], error: null });
          if (columns === 'attempt, last_error') {
            return makeQuery(options.highestAttemptError
              ? { data: null, error: options.highestAttemptError }
              : { data: options.highestAttempt ?? [], error: null });
          }
          if (columns === 'start_node_id') return makeQuery({ data: options.runRow ?? null, error: null });
          if (columns === 'id') return makeQuery({ data: options.duePending ?? [], error: null });
          throw new Error(`Unexpected select on ${table}: ${columns}`);
        },
        update(values: Record<string, unknown>) {
          runUpdates.push(values);
          return makeQuery({ data: null, error: null });
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === 'list_stalled_workflow_runs_without_live_jobs') {
        return { data: options.stalledRuns ?? [], error: null };
      }
      if (fn === 'claim_workflow_run_step_jobs') return { data: options.claimed ?? [], error: null };
      if (fn === 'heartbeat_workflow_run_step_job') {
        return { data: options.heartbeat ?? true, error: null };
      }
      if (fn === 'enqueue_workflow_run_step_job') return { data: 'job-new', error: null };
      if (fn === 'defer_workflow_run_step_job') return { data: 'deferred', error: null };
      if (fn === 'finish_workflow_run_step_job') return { data: 'succeeded', error: null };
      return { data: null, error: null };
    },
  };

  return client;
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    run_id: 'run-1',
    canvas_id: 'canvas-1',
    node_id: 'node-1',
    attempt: 1,
    status: 'processing',
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

describe('workflow run step queue client', () => {
  it('backs off exponentially and caps the delay', () => {
    expect(getWorkflowRunStepRetryDelaySeconds(1)).toBe(60);
    expect(getWorkflowRunStepRetryDelaySeconds(2)).toBe(120);
    expect(getWorkflowRunStepRetryDelaySeconds(3)).toBe(240);
    // Capped so an exhausted-but-retrying job cannot drift days out.
    expect(getWorkflowRunStepRetryDelaySeconds(20)).toBe(15 * 60);
    expect(getWorkflowRunStepRetryDelaySeconds(Number.NaN)).toBe(60);
  });

  it('treats a job orphaned before its first heartbeat as due', async () => {
    // heartbeat_at is the live signal, but a worker that died between claiming
    // and its first heartbeat leaves it null -- probing only heartbeat_at would
    // strand exactly the jobs the reclaim exists for.
    const client = createFakeClient({ duePending: [] });
    const seenFilters: string[] = [];
    const probeClient = {
      from() {
        return {
          select() {
            const query: Record<string, unknown> = {};
            for (const method of ['eq', 'lte', 'limit']) query[method] = () => query;
            query.is = (column: string) => {
              seenFilters.push(`is:${column}`);
              return query;
            };
            query.then = (resolve: (v: QueryResult) => unknown) =>
              Promise.resolve({ data: [], error: null }).then(resolve);
            return query;
          },
        };
      },
    };

    await hasDueWorkflowRunStepJobs(probeClient as never, { nowMs: NOW });
    expect(seenFilters).toContain('is:heartbeat_at');
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('rejects a nonsense prune window rather than silently pruning', () => {
    expect(() => shouldPruneWorkflowRunStepJobs(NOW, { windowMinutes: 0 })).toThrow();
    expect(() => shouldPruneWorkflowRunStepJobs(NOW, { windowMinutes: 61 })).toThrow();
    expect(shouldPruneWorkflowRunStepJobs(Date.parse('2026-08-09T12:02:00.000Z'))).toBe(true);
    expect(shouldPruneWorkflowRunStepJobs(Date.parse('2026-08-09T12:30:00.000Z'))).toBe(false);
  });

  it('delegates stalled-run exclusion and limiting to one database RPC', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-orphan', canvas_id: 'canvas-1' }],
    });

    const stalled = await findStalledWorkflowRuns(client, {
      nowMs: NOW,
      stallSeconds: 120,
      limit: 7,
    });

    expect(stalled).toEqual([{ id: 'run-orphan', canvas_id: 'canvas-1' }]);
    expect(client.rpcCalls).toContainEqual({
      fn: 'list_stalled_workflow_runs_without_live_jobs',
      args: {
        p_created_before: '2026-08-09T11:58:00.000Z',
        p_limit: 7,
      },
    });
  });

  it('rejects an adoption page larger than the bounded database contract', async () => {
    const client = createFakeClient();
    await expect(findStalledWorkflowRuns(client, { nowMs: NOW, limit: 101 })).rejects.toThrow(
      'between 1 and 100',
    );
    expect(client.rpcCalls).toHaveLength(0);
  });
});

describe('workflow run step worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the database lease alive throughout a long branch advance', async () => {
    vi.useFakeTimers();
    const client = createFakeClient({ claimed: [makeJob()] });
    let resolveAdvance!: (value: { status: string; created_at: string }) => void;
    const advanceRun = vi.fn(() => new Promise((resolve) => {
      resolveAdvance = resolve;
    }));

    const processing = processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });
    await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_HEARTBEAT_INTERVAL_MS + 1);

    expect(client.rpcCalls.filter((call) => call.fn === 'heartbeat_workflow_run_step_job')).toHaveLength(1);
    resolveAdvance({ status: 'succeeded', created_at: new Date(NOW - 60_000).toISOString() });
    const summary = await processing;
    expect(summary.advanced).toBe(1);
  });

  it('defers a run that is still waiting instead of spending an attempt', async () => {
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn(async () => ({
      status: 'processing',
      created_at: new Date(NOW - 60_000).toISOString(),
    }));

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.deferred).toBe(1);
    expect(summary.advanced).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).toContain('defer_workflow_run_step_job');
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('finish_workflow_run_step_job');
  });

  it('finishes a run that reached a terminal state', async () => {
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn(async () => ({
      status: 'succeeded',
      created_at: new Date(NOW - 60_000).toISOString(),
    }));

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.advanced).toBe(1);
    const finish = client.rpcCalls.find((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finish?.args.p_succeeded).toBe(true);
  });

  it('stops without reporting an outcome when the lease was lost mid-advance', async () => {
    // Another worker has taken over. Reporting an outcome here would clobber
    // whatever the new holder records.
    const client = createFakeClient({ claimed: [makeJob()], heartbeat: false });
    const advanceRun = vi.fn(async () => ({
      status: 'succeeded',
      created_at: new Date(NOW - 60_000).toISOString(),
    }));

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.advanced).toBe(0);
    expect(summary.deferred).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('finish_workflow_run_step_job');
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('defer_workflow_run_step_job');
  });

  it('stops deferring once a run outlives its maximum lifetime', async () => {
    // Otherwise a run whose generation never completes is polled forever.
    const client = createFakeClient({ claimed: [makeJob({ attempt: 2 })] });
    const advanceRun = vi.fn(async () => ({
      status: 'processing',
      created_at: new Date(NOW - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 60) * 1000).toISOString(),
    }));
    // The run is ended while its ticket is still held.
    const endGivenUpRun = vi.fn(async () => {
      expect(client.rpcCalls.map((call) => call.fn)).not.toContain('finish_workflow_run_step_job');
      return 'failed' as const;
    });

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
      endGivenUpRun,
    });

    expect(summary.deferred).toBe(0);
    expect(endGivenUpRun).toHaveBeenCalledTimes(1);
    expect(endGivenUpRun).toHaveBeenCalledWith({
      supabase: client,
      runId: 'run-1',
      nowMs: NOW,
      lastError: 'Workflow run exceeded its maximum lifetime without finishing.',
    });
    // Ending the run is the runner's: it closes the steps, and a write of the
    // run alone is what left a run stored as failed and read as processing.
    expect(client.runUpdates).toEqual([]);
    const finish = client.rpcCalls.find((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finish?.args.p_succeeded).toBe(false);
    expect(String(finish?.args.p_error)).toContain('maximum lifetime');
    // No retry is scheduled for a run that is over.
    expect(finish?.args.p_max_attempts).toBe(2);
  });

  it('retries the ticket when a run past its lifetime could not be ended', async () => {
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn(async () => ({
      status: 'processing',
      created_at: new Date(NOW - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 60) * 1000).toISOString(),
    }));
    const endGivenUpRun = vi.fn().mockRejectedValue({ message: 'connection reset', code: '08006' });

    await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
      endGivenUpRun,
    });

    // The ticket is failed with what the database said and under the usual
    // cap, so the next attempt ends the run.
    const finishes = client.rpcCalls.filter((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finishes).toHaveLength(1);
    expect(finishes[0].args).toMatchObject({
      p_succeeded: false,
      p_error: 'connection reset (code 08006)',
      p_max_attempts: 5,
    });
  });

  it('never ends a run that is still inside its lifetime', async () => {
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn(async () => ({
      status: 'processing',
      created_at: new Date(NOW - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS - 60) * 1000).toISOString(),
    }));
    const endGivenUpRun = vi.fn();

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
      endGivenUpRun,
    });

    expect(summary.deferred).toBe(1);
    expect(endGivenUpRun).not.toHaveBeenCalled();
  });

  it('records a failed advance as a retry with backoff', async () => {
    const client = createFakeClient({ claimed: [makeJob({ attempt: 2 })] });
    const advanceRun = vi.fn(async () => {
      throw new Error('node exploded');
    });

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.advanced).toBe(0);
    const finish = client.rpcCalls.find((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finish?.args.p_succeeded).toBe(false);
    expect(finish?.args.p_error).toBe('node exploded');
    expect(finish?.args.p_retry_delay_seconds).toBe(120);
  });

  it('records what the database said when a write is refused mid-advance', async () => {
    // supabase-js answers a refused write with a plain object, not an Error,
    // and the runner's helpers throw it as it is. last_error is the only place
    // the reason is kept, and String() of that object is "[object Object]".
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn().mockRejectedValue({ message: 'connection reset', code: '08006' });

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.advanced).toBe(0);
    const finish = client.rpcCalls.find((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finish?.args.p_succeeded).toBe(false);
    expect(finish?.args.p_error).toBe('connection reset (code 08006)');
    expect(finish?.args.p_retry_delay_seconds).toBe(60);
  });
});

describe('stalled workflow run adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adopts an unfinished run that has no live job', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }],
      liveJobs: [],
      highestAttempt: [{ attempt: 2 }],
      runRow: { start_node_id: 'node-1' },
    });

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW });

    expect(adopted).toBe(1);
    const enqueue = client.rpcCalls.find((call) => call.fn === 'enqueue_workflow_run_step_job');
    // Next free attempt, so the unique (run, node, attempt) key cannot collide
    // with a terminated earlier attempt.
    expect(enqueue?.args).toMatchObject({ p_run_id: 'run-1', p_node_id: 'node-1', p_attempt: 3 });
  });

  it('leaves a run alone when a job is already pending or processing', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }],
      liveJobs: [{ run_id: 'run-1', attempt: 1 }],
    });
    const endGivenUpRun = vi.fn();

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW, endGivenUpRun });

    expect(adopted).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('enqueue_workflow_run_step_job');
    expect(endGivenUpRun).not.toHaveBeenCalled();
  });

  it('gives a run with one attempt left its last ticket', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }],
      highestAttempt: [{ attempt: 4, last_error: 'connection reset' }],
      runRow: { start_node_id: 'node-1' },
    });
    const endGivenUpRun = vi.fn();

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW, endGivenUpRun });

    expect(adopted).toBe(1);
    const enqueue = client.rpcCalls.find((call) => call.fn === 'enqueue_workflow_run_step_job');
    expect(enqueue?.args).toMatchObject({ p_run_id: 'run-1', p_attempt: 5 });
    expect(endGivenUpRun).not.toHaveBeenCalled();
  });

  it('hands a run whose job has used every attempt to be ended, with what its last tick failed on', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }],
      highestAttempt: [{ attempt: 5, last_error: 'duplicate key value (code 23505)' }],
      runRow: { start_node_id: 'node-1' },
    });
    const endGivenUpRun = vi.fn(async () => 'failed' as const);

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW, endGivenUpRun });

    expect(endGivenUpRun).toHaveBeenCalledTimes(1);
    expect(endGivenUpRun).toHaveBeenCalledWith({
      supabase: client,
      runId: 'run-1',
      nowMs: NOW,
      lastError: 'duplicate key value (code 23505)',
    });
    // No ticket past the cap, and the run is not counted as picked up again.
    expect(adopted).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('enqueue_workflow_run_step_job');
    // Ending the run is the runner's. The sweep writes nothing itself.
    expect(client.runUpdates).toEqual([]);
  });

  it('logs a given-up run that could not be ended and carries on with the rest', async () => {
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }, { id: 'run-2', canvas_id: 'canvas-2' }],
      highestAttempt: [{ attempt: 5, last_error: null }],
    });
    const refused = { message: 'canceling statement due to statement timeout', code: '57014' };
    const endGivenUpRun = vi.fn(async ({ runId }: { runId: string }) => {
      if (runId === 'run-1') throw refused;
      return 'waiting' as const;
    });

    const adopted = await adoptStalledWorkflowRuns({
      supabase: client as never,
      nowMs: NOW,
      endGivenUpRun: endGivenUpRun as never,
    });

    expect(adopted).toBe(0);
    expect(endGivenUpRun.mock.calls.map(([params]) => params.runId)).toEqual(['run-1', 'run-2']);
    // The run is still in progress, so the next sweep meets it again.
    expect(vi.mocked(logBackendError).mock.calls).toEqual([
      ['workflow_run_adopt_failed', { error: refused, runId: 'run-1' }],
    ]);
  });

  it('does not take a failed read of the used attempts for a run with none used', async () => {
    const refused = { message: 'connection reset', code: '08006' };
    const client = createFakeClient({
      stalledRuns: [{ id: 'run-1', canvas_id: 'canvas-1' }],
      highestAttemptError: refused,
      runRow: { start_node_id: 'node-1' },
    });
    const endGivenUpRun = vi.fn();

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW, endGivenUpRun });

    // Neither a ticket nor an ending is decided on a number that was not read.
    expect(adopted).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('enqueue_workflow_run_step_job');
    expect(endGivenUpRun).not.toHaveBeenCalled();
    expect(vi.mocked(logBackendError).mock.calls).toEqual([
      ['workflow_run_adopt_failed', { error: refused, runId: 'run-1' }],
    ]);
  });
});
