import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyGenerationStatus: (...args: unknown[]) => mocks.notify(...args),
}));
vi.mock('@/lib/completed-remix-notification', () => ({ notifyCompletedRemix: vi.fn() }));

import {
  GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE,
  GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS,
  GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES,
  classifyGenerationOutputImportError,
  hasDueGenerationOutputImportRetries,
  isGenerationOutputImportRetrying,
  retryOrAbandonExhaustedGenerationOutputImports,
} from '@/lib/generation-output-import-retries';

type Result = { data: unknown; error: unknown };

class Builder {
  calls: Array<[string, unknown[]]> = [];
  constructor(private readonly result: Result) {}
  private record(name: string, args: unknown[]) {
    this.calls.push([name, args]);
    return this;
  }
  select(...args: unknown[]) { return this.record('select', args); }
  update(...args: unknown[]) { return this.record('update', args); }
  eq(...args: unknown[]) { return this.record('eq', args); }
  in(...args: unknown[]) { return this.record('in', args); }
  or(...args: unknown[]) { return this.record('or', args); }
  order(...args: unknown[]) { return this.record('order', args); }
  limit(...args: unknown[]) { return this.record('limit', args); }
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ) {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function createClient(results: Result[], rpcResults: Result[] = []) {
  const builders: Builder[] = [];
  const from = vi.fn((table: string) => {
    expect(table).toBe('generation_output_import_jobs');
    const result = results.shift();
    if (!result) throw new Error('Unexpected query');
    const builder = new Builder(result);
    builders.push(builder);
    return builder;
  });
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    void _name; void _args;
    const result = rpcResults.shift();
    if (!result) throw new Error('Unexpected RPC');
    return result;
  });
  return { client: { from, rpc }, builders, rpc };
}

const NOW_MS = Date.UTC(2026, 10, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function exhaustedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'import-1',
    status: 'failed',
    locked_at: null,
    generation_id: 'generation-1',
    prediction_id: 'task-1',
    provider_completed_at: new Date(NOW_MS - 5 * HOUR).toISOString(),
    created_at: new Date(NOW_MS - 5 * HOUR + 60_000).toISOString(),
    completed_at: new Date(NOW_MS - 2 * HOUR).toISOString(),
    last_error: 'Remote media host is not allowlisted.',
    generations: {
      id: 'generation-1',
      user_id: 'user-1',
      status: 'processing',
      category: 'video',
      model: 'veo3',
      template_run_id: null,
    },
    ...overrides,
  };
}

describe('exhausted generation output imports', () => {
  beforeEach(() => {
    mocks.notify.mockReset().mockResolvedValue(null);
  });

  it('retries for 24 hours, about once an hour', () => {
    expect(GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS).toBe(24);
    expect(GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES).toBe(60);
  });

  it('selects only exhausted imports of generations that are still active, due a retry or past the window', async () => {
    const { client, builders } = createClient([{ data: [], error: null }]);

    await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

    const calls = builders[0].calls;
    expect(calls).toContainEqual(['select', [expect.stringContaining('generations!inner(')]]);
    // Every import that has not succeeded: an exhausted one due its retry, and
    // any (failed, pending, or processing under a dead worker) past its window.
    expect(calls).toContainEqual(['in', ['status', ['failed', 'pending', 'processing']]]);
    expect(calls).toContainEqual(['in', ['generations.status', ['waiting', 'processing']]]);
    expect(calls).toContainEqual(['or', [[
      'and(status.eq.failed,completed_at.lte.2026-11-27T11:00:00.000Z)',
      'created_at.lte.2026-11-26T12:00:00.000Z',
      'provider_completed_at.lte.2026-11-26T12:00:00.000Z',
    ].join(',')]]);
    expect(calls).toContainEqual(['order', ['updated_at', { ascending: true }]]);
  });

  it('reopens an exhausted import an hour after its last attempt while the provider file may still exist', async () => {
    const { client, builders, rpc } = createClient([
      { data: [exhaustedJob()], error: null },
      { data: [{ id: 'import-1' }], error: null },
    ]);

    const summary = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

    expect(summary).toEqual({ eligible: 1, reopened: 1, abandoned: 0, skipped: 0, failed: 0, deferred: 0 });
    expect(builders[1].calls).toEqual([
      ['update', [{ status: 'pending', next_attempt_at: '2026-11-27T12:00:00.000Z', updated_at: '2026-11-27T12:00:00.000Z' }]],
      ['eq', ['id', 'import-1']],
      ['eq', ['status', 'failed']],
      ['select', ['id']],
    ]);
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not reopen an import tried less than an hour ago', async () => {
    const { client, rpc } = createClient([
      { data: [exhaustedJob({ completed_at: new Date(NOW_MS - 20 * 60_000).toISOString() })], error: null },
    ]);

    const summary = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

    expect(summary).toMatchObject({ reopened: 0, skipped: 1, abandoned: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails and refunds the generation once the window since the provider finished has ended, and tells the creator', async () => {
    const job = exhaustedJob({
      provider_completed_at: new Date(NOW_MS - 24 * HOUR - 1).toISOString(),
      // Queued later than the provider finished: the window runs from the earlier.
      created_at: new Date(NOW_MS - 23 * HOUR).toISOString(),
      completed_at: new Date(NOW_MS - 10 * 60_000).toISOString(),
    });
    const { client, builders, rpc } = createClient(
      [{ data: [job], error: null }, { data: null, error: null }],
      [{ data: { status: 'failed', refunded: true }, error: null }],
    );

    const summary = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

    expect(summary).toEqual({ eligible: 1, reopened: 0, abandoned: 1, skipped: 0, failed: 0, deferred: 0 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('settle_generation_failed', {
      p_prediction_id: 'task-1',
      p_completed_at: null,
      p_error_message: GENERATION_OUTPUT_IMPORT_ABANDONED_MESSAGE,
    });
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(client, job.generations, 'failed');
    // Nothing reopens it: the job is closed, conditional on the state it was read in.
    expect(builders).toHaveLength(2);
    expect(builders[1].calls).toEqual([
      ['update', [{ status: 'cancelled', locked_at: null, locked_by: null, updated_at: '2026-11-27T12:00:00.000Z' }]],
      ['eq', ['id', 'import-1']],
      ['eq', ['status', 'failed']],
    ]);
  });

  describe('an import whose worker was killed mid-run', () => {
    const pastWindow = {
      provider_completed_at: new Date(NOW_MS - 25 * HOUR).toISOString(),
      created_at: new Date(NOW_MS - 25 * HOUR).toISOString(),
      completed_at: null,
    };

    it('fails and refunds the generation once its window has ended, and closes the job', async () => {
      const job = exhaustedJob({ ...pastWindow, status: 'processing', locked_at: new Date(NOW_MS - 10 * 60_000).toISOString() });
      const { client, builders, rpc } = createClient(
        [{ data: [job], error: null }, { data: null, error: null }],
        [{ data: { status: 'failed', refunded: true }, error: null }],
      );

      const summary = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

      expect(summary).toMatchObject({ abandoned: 1, failed: 0 });
      expect(rpc).toHaveBeenCalledExactlyOnceWith('settle_generation_failed', expect.objectContaining({ p_prediction_id: 'task-1' }));
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      expect(builders[1].calls).toContainEqual(['eq', ['status', 'processing']]);
    });

    it('also ends a job left pending past its window', async () => {
      const { client, rpc } = createClient(
        [{ data: [exhaustedJob({ ...pastWindow, status: 'pending' })], error: null }, { data: null, error: null }],
        [{ data: { status: 'failed', refunded: true }, error: null }],
      );
      await expect(retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS }))
        .resolves.toMatchObject({ abandoned: 1 });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('leaves a job whose worker still holds a live lease, even past the window', async () => {
      const job = exhaustedJob({ ...pastWindow, status: 'processing', locked_at: new Date(NOW_MS - 60_000).toISOString() });
      const { client, rpc } = createClient([{ data: [job], error: null }]);
      await expect(retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS }))
        .resolves.toMatchObject({ abandoned: 0, skipped: 1 });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('never reopens a job that is not failed', async () => {
      const { client, rpc, builders } = createClient([{ data: [exhaustedJob({ status: 'pending', completed_at: null })], error: null }]);
      await expect(retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS }))
        .resolves.toMatchObject({ reopened: 0, skipped: 1 });
      expect(rpc).not.toHaveBeenCalled();
      expect(builders).toHaveLength(1);
    });
  });

  it('announces nothing when the import landed first or the generation is gone, and keeps going after a settlement error', async () => {
    const old = { provider_completed_at: new Date(NOW_MS - 30 * HOUR).toISOString() };
    const { client, rpc, builders } = createClient(
      [{
        data: [
          exhaustedJob({ id: 'import-1', prediction_id: 'task-1', ...old }),
          exhaustedJob({ id: 'import-2', prediction_id: 'task-2', ...old }),
          exhaustedJob({ id: 'import-3', prediction_id: 'task-3', ...old }),
          exhaustedJob({ id: 'import-4', prediction_id: 'task-4', ...old }),
        ],
        error: null,
      }, { data: null, error: null }, { data: null, error: null }],
      [
        { data: { status: 'already_succeeded' }, error: null },
        { data: { status: 'missing' }, error: null },
        { data: null, error: { message: 'database unavailable' } },
        { data: { status: 'failed', refunded: true }, error: null },
      ],
    );

    const summary = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });

    expect(summary).toEqual({ eligible: 4, reopened: 0, abandoned: 1, skipped: 2, failed: 1, deferred: 0 });
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    // The row whose settlement failed is stamped to the back; the settled one is closed.
    expect(builders[1].calls).toEqual([
      ['update', [{ updated_at: '2026-11-27T12:00:00.000Z' }]],
      ['eq', ['id', 'import-3']],
    ]);
    expect(builders[2].calls[0]).toEqual(['update', [expect.objectContaining({ status: 'cancelled' })]]);
  });

  it('moves a row it cannot settle to the back, so more of them than the batch cannot starve the rest', async () => {
    // An in-memory queue that orders and limits like the query does.
    type Job = ReturnType<typeof exhaustedJob> & { updated_at: string };
    const past = new Date(NOW_MS - 30 * HOUR).toISOString();
    const jobs: Job[] = Array.from({ length: 11 }, (_, index) => ({
      ...exhaustedJob({ id: `import-${index}`, prediction_id: index < 10 ? `stuck-${index}` : 'ok', provider_completed_at: past }),
      updated_at: new Date(NOW_MS - (60 - index) * 60_000).toISOString(),
    }));
    const settled: string[] = [];
    const client = {
      from: () => {
        let patch: Record<string, unknown> | null = null;
        let id: string | null = null;
        let limitCount = Infinity;
        const builder = {
          select: () => builder,
          in: () => builder,
          or: () => builder,
          order: () => builder,
          update: (values: Record<string, unknown>) => { patch = values; return builder; },
          eq: (column: string, value: unknown) => { if (column === 'id') id = String(value); return builder; },
          limit: (count: number) => { limitCount = count; return builder; },
          then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
            if (patch) {
              const job = jobs.find((row) => row.id === id);
              if (job) Object.assign(job, patch);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            }
            const open = jobs.filter((row) => !settled.includes(row.prediction_id) && row.status !== 'cancelled');
            const page = [...open].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, limitCount);
            return Promise.resolve({ data: page, error: null }).then(resolve);
          },
        };
        return builder;
      },
      rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        if (String(args.p_prediction_id).startsWith('stuck-')) return { data: null, error: { message: 'profile locked' } };
        settled.push(String(args.p_prediction_id));
        return { data: { status: 'failed', refunded: true }, error: null };
      }),
    };

    const first = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS });
    expect(first).toMatchObject({ eligible: 10, failed: 10, abandoned: 0 });

    const second = await retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS + 10 * 60_000 });
    expect(second).toMatchObject({ abandoned: 1 });
    expect(settled).toEqual(['ok']);
  });

  it('defers what it cannot start before the run deadline', async () => {
    const { client, rpc } = createClient([{ data: [exhaustedJob(), exhaustedJob({ id: 'import-2' })], error: null }]);

    const summary = await retryOrAbandonExhaustedGenerationOutputImports({
      client: client as never,
      nowMs: NOW_MS,
      deadlineMs: Date.now() - 1,
    });

    expect(summary).toMatchObject({ eligible: 2, deferred: 2, reopened: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when the batch cannot be read, so the run records it', async () => {
    const { client } = createClient([{ data: null, error: { message: 'boom' } }]);
    await expect(retryOrAbandonExhaustedGenerationOutputImports({ client: client as never, nowMs: NOW_MS }))
      .rejects.toMatchObject({ message: 'boom' });
  });

  it('probes for due retries with a one-row read', async () => {
    const { client, builders } = createClient([{ data: [{ id: 'import-1' }], error: null }]);
    await expect(hasDueGenerationOutputImportRetries(client as never, { nowMs: NOW_MS })).resolves.toBe(true);
    expect(builders[0].calls).toContainEqual(['limit', [1]]);
  });

  describe('which generations health leaves to the import window', () => {
    const now = new Date(NOW_MS);
    it('counts a finished provider task whose import is still retrying inside the window', () => {
      for (const status of ['pending', 'processing', 'failed']) {
        expect(isGenerationOutputImportRetrying({
          status,
          provider_completed_at: new Date(NOW_MS - 23 * HOUR).toISOString(),
          created_at: new Date(NOW_MS - 23 * HOUR).toISOString(),
        }, now)).toBe(true);
      }
    });
    it('does not once the window has ended, or for a finished or missing import', () => {
      expect(isGenerationOutputImportRetrying({
        status: 'failed',
        provider_completed_at: new Date(NOW_MS - 25 * HOUR).toISOString(),
        created_at: new Date(NOW_MS - 2 * HOUR).toISOString(),
      }, now)).toBe(false);
      expect(isGenerationOutputImportRetrying({
        status: 'succeeded', provider_completed_at: null, created_at: new Date(NOW_MS - HOUR).toISOString(),
      }, now)).toBe(false);
      expect(isGenerationOutputImportRetrying(null, now)).toBe(false);
      expect(isGenerationOutputImportRetrying([], now)).toBe(false);
      expect(isGenerationOutputImportRetrying({ status: 'pending', provider_completed_at: null, created_at: null }, now)).toBe(false);
    });
  });

  it('names the cause an owner can act on', () => {
    expect(classifyGenerationOutputImportError('Remote media host is not allowlisted.')).toBe('host_not_allowed');
    expect(classifyGenerationOutputImportError('Remote media exceeds the allowed size.')).toBe('file_too_large');
    expect(classifyGenerationOutputImportError('The object exceeded the maximum allowed size')).toBe('file_too_large');
    expect(classifyGenerationOutputImportError('Remote media request failed with status 404.')).toBe('provider_fetch_failed');
    expect(classifyGenerationOutputImportError('fetch failed')).toBe('provider_fetch_failed');
    expect(classifyGenerationOutputImportError('Bucket not found (code 404)')).toBe('storage_failed');
    expect(classifyGenerationOutputImportError(null)).toBe('other');
    expect(classifyGenerationOutputImportError('Output persistence settled as failed.')).toBe('other');
  });
});
