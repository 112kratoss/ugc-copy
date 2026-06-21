import { describe, expect, it, vi } from 'vitest';

import { collectBackendHealth } from '@/lib/backend-health';

type QueryResult = {
  data: unknown[] | null;
  error: Error | null;
};

class FakeQueryBuilder {
  select = vi.fn(() => this);
  gte = vi.fn(() => this);
  order = vi.fn(() => this);
  limit = vi.fn(() => this);
  in = vi.fn(() => this);
  lt = vi.fn(() => this);

  constructor(private readonly result: QueryResult) {}

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function createClient(results: Record<string, QueryResult | QueryResult[]>) {
  const builders: Record<string, FakeQueryBuilder[]> = {};
  const from = vi.fn((table: string) => {
    const tableResults = Array.isArray(results[table])
      ? results[table] as QueryResult[]
      : [results[table] as QueryResult];
    const index = builders[table]?.length ?? 0;
    const result = tableResults[index];
    if (!result) throw new Error(`Unexpected table query: ${table}`);
    const builder = new FakeQueryBuilder(result);
    builders[table] = [...(builders[table] ?? []), builder];
    return builder;
  });

  return {
    client: { from },
    from,
    builders,
  };
}

describe('collectBackendHealth', () => {
  it('returns ok when scheduled jobs recently succeeded and no generations are stalled', async () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'media-preview-repair',
            status: 'succeeded',
            started_at: '2026-06-21T09:45:00.000Z',
            finished_at: '2026-06-21T09:45:02.000Z',
            duration_ms: 2000,
            skip_reason: null,
            error_message: null,
          },
          {
            job_name: 'mobile-push-receipts',
            status: 'succeeded',
            started_at: '2026-06-21T00:15:00.000Z',
            finished_at: '2026-06-21T00:15:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
        ],
      },
      generations: [
        {
          error: null,
          data: [
            { status: 'succeeded', created_at: '2026-06-21T09:50:00.000Z' },
            { status: 'failed', created_at: '2026-06-21T09:55:00.000Z' },
          ],
        },
        { error: null, data: [] },
      ],
    });

    const health = await collectBackendHealth(db.client as never, now);

    expect(health.status).toBe('ok');
    expect(health.catalog.activeModels).toBeGreaterThan(0);
    expect(health.jobs).toHaveLength(2);
    expect(health.generations).toMatchObject({
      status: 'ok',
      recentCounts: { succeeded: 1, failed: 1 },
      stalledActiveCount: 0,
    });
    expect(db.from).toHaveBeenCalledWith('backend_job_runs');
    expect(db.from).toHaveBeenCalledWith('generations');
    expect(db.builders.backend_job_runs[0].gte).toHaveBeenCalledWith(
      'started_at',
      '2026-06-19T10:00:00.000Z',
    );
  });

  it('warns when a scheduled job has no recent run records', async () => {
    const db = createClient({
      backend_job_runs: { error: null, data: [] },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    const health = await collectBackendHealth(db.client as never, new Date('2026-06-21T10:00:00.000Z'));

    expect(health.status).toBe('warning');
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOB_NO_RECENT_RUN', severity: 'warning' }),
    ]));
  });

  it('degrades when the latest run failed or active generations are stalled', async () => {
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'media-preview-repair',
            status: 'failed',
            started_at: '2026-06-21T09:55:00.000Z',
            finished_at: '2026-06-21T09:55:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: 'repair failed',
          },
          {
            job_name: 'mobile-push-receipts',
            status: 'succeeded',
            started_at: '2026-06-21T00:15:00.000Z',
            finished_at: '2026-06-21T00:15:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
        ],
      },
      generations: [
        { error: null, data: [] },
        { error: null, data: [{ created_at: '2026-06-21T08:30:00.000Z' }] },
      ],
    });

    const health = await collectBackendHealth(db.client as never, new Date('2026-06-21T10:00:00.000Z'));

    expect(health.status).toBe('degraded');
    expect(health.jobs.find((job) => job.name === 'media-preview-repair')?.latestRun).toMatchObject({
      hasError: true,
    });
    expect(health.jobs.find((job) => job.name === 'media-preview-repair')?.latestRun).not.toHaveProperty(
      'errorMessage',
    );
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOB_LATEST_RUN_FAILED', severity: 'degraded' }),
      expect.objectContaining({ code: 'GENERATION_STALLED_ACTIVE', severity: 'degraded' }),
    ]));
  });

  it('throws when an operational query fails', async () => {
    const db = createClient({
      backend_job_runs: { data: null, error: new Error('database unavailable') },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    await expect(collectBackendHealth(db.client as never)).rejects.toThrow('database unavailable');
  });
});
