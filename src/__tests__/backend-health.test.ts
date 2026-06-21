import { describe, expect, it, vi } from 'vitest';

import { collectBackendHealth } from '@/lib/backend-health';

type QueryResult = {
  data: unknown[] | null;
  error: Error | null;
};

class FakeQueryBuilder {
  select = vi.fn(() => this);
  gte = vi.fn(() => this);
  eq = vi.fn(() => this);
  is = vi.fn(() => this);
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
  const tableResultsByName: Record<string, QueryResult | QueryResult[]> = {
    ai_usage_events: [
      { error: null, data: [] },
      { error: null, data: [] },
    ],
    generation_completion_jobs: { error: null, data: [] },
    ...results,
  };
  const builders: Record<string, FakeQueryBuilder[]> = {};
  const from = vi.fn((table: string) => {
    const tableResults = Array.isArray(tableResultsByName[table])
      ? tableResultsByName[table] as QueryResult[]
      : [tableResultsByName[table] as QueryResult];
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
          {
            job_name: 'generation-completions',
            status: 'succeeded',
            started_at: '2026-06-21T09:58:00.000Z',
            finished_at: '2026-06-21T09:58:01.000Z',
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
            { status: 'succeeded', created_at: '2026-06-21T09:50:00.000Z', cost: 8 },
            { status: 'failed', created_at: '2026-06-21T09:55:00.000Z', cost: 12 },
          ],
        },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    const health = await collectBackendHealth(db.client as never, now);

    expect(health.status).toBe('ok');
    expect(health.catalog.activeModels).toBeGreaterThan(0);
    expect(health.jobs).toHaveLength(3);
    expect(health.jobs.find((job) => job.name === 'generation-completions')).toMatchObject({
      status: 'ok',
      expectedMaxAgeMinutes: 30,
    });
    expect(health.jobs.find((job) => job.name === 'media-preview-repair')).toMatchObject({
      status: 'ok',
      expectedMaxAgeMinutes: 120,
    });
    expect(health.generations).toMatchObject({
      status: 'ok',
      recentCounts: { succeeded: 1, failed: 1 },
      recentCreditCostTotal: 20,
      recentCreditCostByStatus: { succeeded: 8, failed: 12 },
      stalledActiveCreditCost: 0,
      stalledActiveCount: 0,
    });
    expect(db.from).toHaveBeenCalledWith('backend_job_runs');
    expect(db.from).toHaveBeenCalledWith('generations');
    expect(db.from).toHaveBeenCalledWith('generation_completion_jobs');
    expect(db.builders.backend_job_runs[0].gte).toHaveBeenCalledWith(
      'started_at',
      '2026-06-19T10:00:00.000Z',
    );
    expect(db.builders.generations[0].select).toHaveBeenCalledWith('status,created_at,cost');
    expect(db.builders.generations[1].select).toHaveBeenCalledWith('created_at,cost');
    expect(db.builders.generations[1].in).toHaveBeenCalledWith('status', ['pending', 'waiting', 'processing']);
    expect(db.builders.generations[2].select).toHaveBeenCalledWith('created_at,cost');
    expect(db.builders.generations[2].eq).toHaveBeenCalledWith('status', 'pending');
    expect(db.builders.generations[2].is).toHaveBeenCalledWith('prediction_id', null);
  });

  it('reports non-generation AI usage spend, refunds, and stale pending charges', async () => {
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
          {
            job_name: 'generation-completions',
            status: 'succeeded',
            started_at: '2026-06-21T09:58:00.000Z',
            finished_at: '2026-06-21T09:58:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
        ],
      },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
      ai_usage_events: [
        {
          error: null,
          data: [
            {
              feature: 'prompt_enhancement',
              status: 'succeeded',
              medium: 'image',
              cost: 2,
              created_at: '2026-06-21T09:55:00.000Z',
            },
            {
              feature: 'workflow_assistant',
              status: 'refunded',
              medium: 'video',
              cost: '5',
              created_at: '2026-06-21T09:50:00.000Z',
            },
            {
              feature: 'workflow_blueprint',
              status: 'pending',
              medium: 'video',
              cost: 8,
              created_at: '2026-06-21T09:40:00.000Z',
            },
          ],
        },
        {
          error: null,
          data: [
            {
              feature: 'workflow_blueprint',
              status: 'pending',
              medium: 'video',
              cost: 8,
              created_at: '2026-06-21T09:40:00.000Z',
            },
          ],
        },
      ],
    });

    const health = await collectBackendHealth(db.client as never, now);

    expect(health.status).toBe('degraded');
    expect(health.aiUsage).toMatchObject({
      status: 'degraded',
      recentCounts: { succeeded: 1, refunded: 1, pending: 1 },
      recentCreditCostTotal: 15,
      recentCreditCostByStatus: { succeeded: 2, refunded: 5, pending: 8 },
      recentCreditCostByFeature: {
        prompt_enhancement: 2,
        workflow_assistant: 5,
        workflow_blueprint: 8,
      },
      refundedCount: 1,
      refundedCreditCost: 5,
      stalePendingCount: 1,
      stalePendingCreditCost: 8,
      oldestStalePendingCreatedAt: '2026-06-21T09:40:00.000Z',
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AI_USAGE_STALE_PENDING',
        severity: 'degraded',
      }),
    ]));
    expect(db.from).toHaveBeenCalledWith('ai_usage_events');
    expect(db.builders.ai_usage_events[0].select).toHaveBeenCalledWith('feature,status,medium,cost,created_at');
    expect(db.builders.ai_usage_events[0].gte).toHaveBeenCalledWith(
      'created_at',
      '2026-06-21T09:00:00.000Z',
    );
    expect(db.builders.ai_usage_events[1].eq).toHaveBeenCalledWith('status', 'pending');
    expect(db.builders.ai_usage_events[1].lt).toHaveBeenCalledWith(
      'created_at',
      '2026-06-21T09:45:00.000Z',
    );
  });

  it('warns when a scheduled job has no recent run records', async () => {
    const db = createClient({
      backend_job_runs: { error: null, data: [] },
      generations: [
        { error: null, data: [] },
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
        { error: null, data: [{ created_at: '2026-06-21T08:30:00.000Z', cost: 16 }] },
        { error: null, data: [] },
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
    expect(health.generations.stalledActiveCreditCost).toBe(16);
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOB_LATEST_RUN_FAILED', severity: 'degraded' }),
      expect.objectContaining({ code: 'GENERATION_STALLED_ACTIVE', severity: 'degraded' }),
    ]));
  });

  it('degrades when the generation completion queue has failed or stale due jobs', async () => {
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
          {
            job_name: 'generation-completions',
            status: 'succeeded',
            started_at: '2026-06-21T09:58:00.000Z',
            finished_at: '2026-06-21T09:58:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
        ],
      },
      generation_completion_jobs: {
        error: null,
        data: [
          {
            status: 'pending',
            created_at: '2026-06-21T09:20:00.000Z',
            next_attempt_at: '2026-06-21T09:30:00.000Z',
            locked_at: null,
          },
          {
            status: 'failed',
            created_at: '2026-06-21T09:40:00.000Z',
            next_attempt_at: '2026-06-21T09:40:00.000Z',
            locked_at: null,
          },
        ],
      },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    const health = await collectBackendHealth(db.client as never, new Date('2026-06-21T10:00:00.000Z'));

    expect(health.status).toBe('degraded');
    expect(health.completionQueue).toMatchObject({
      status: 'degraded',
      pendingCount: 1,
      failedCount: 1,
      oldestDuePendingNextAttemptAt: '2026-06-21T09:30:00.000Z',
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GENERATION_COMPLETION_QUEUE_FAILED', severity: 'degraded' }),
      expect.objectContaining({ code: 'GENERATION_COMPLETION_QUEUE_STALE_PENDING', severity: 'degraded' }),
    ]));
  });

  it('degrades when pending generations have no provider task id after the attach window', async () => {
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
          {
            job_name: 'generation-completions',
            status: 'succeeded',
            started_at: '2026-06-21T09:58:00.000Z',
            finished_at: '2026-06-21T09:58:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
        ],
      },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        {
          error: null,
          data: [
            { created_at: '2026-06-21T09:50:00.000Z', cost: 8 },
            { created_at: '2026-06-21T09:52:00.000Z', cost: 12 },
          ],
        },
      ],
    });

    const health = await collectBackendHealth(db.client as never, new Date('2026-06-21T10:00:00.000Z'));

    expect(health.status).toBe('degraded');
    expect(health.generations).toMatchObject({
      pendingWithoutProviderTaskAfterMinutes: 5,
      pendingWithoutProviderTaskCount: 2,
      pendingWithoutProviderTaskCreditCost: 20,
      oldestPendingWithoutProviderTaskCreatedAt: '2026-06-21T09:50:00.000Z',
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'GENERATION_PENDING_WITHOUT_PROVIDER_TASK',
        severity: 'degraded',
      }),
    ]));
    expect(db.builders.generations[2].lt).toHaveBeenCalledWith(
      'created_at',
      '2026-06-21T09:55:00.000Z',
    );
  });

  it('throws when an operational query fails', async () => {
    const db = createClient({
      backend_job_runs: { data: null, error: new Error('database unavailable') },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    await expect(collectBackendHealth(db.client as never)).rejects.toThrow('database unavailable');
  });
});
