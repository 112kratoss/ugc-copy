import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findStalledWorkflowRuns,
  getWorkflowRunStepRetryDelaySeconds,
  hasDueWorkflowRunStepJobs,
  shouldPruneWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs';
import {
  WORKFLOW_RUN_MAX_LIFETIME_SECONDS,
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
          if (columns === 'attempt') return makeQuery({ data: options.highestAttempt ?? [], error: null });
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
    const client = createFakeClient({ claimed: [makeJob()] });
    const advanceRun = vi.fn(async () => ({
      status: 'processing',
      created_at: new Date(NOW - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 60) * 1000).toISOString(),
    }));

    const summary = await processWorkflowRunStepJobs({
      supabase: client as never,
      lockedBy: 'worker-A',
      nowMs: NOW,
      advanceRun: advanceRun as never,
    });

    expect(summary.deferred).toBe(0);
    const finish = client.rpcCalls.find((call) => call.fn === 'finish_workflow_run_step_job');
    expect(finish?.args.p_succeeded).toBe(false);
    expect(String(finish?.args.p_error)).toContain('maximum lifetime');
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
});

describe('stalled workflow run adoption', () => {
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

    const adopted = await adoptStalledWorkflowRuns({ supabase: client as never, nowMs: NOW });

    expect(adopted).toBe(0);
    expect(client.rpcCalls.map((call) => call.fn)).not.toContain('enqueue_workflow_run_step_job');
  });
});
