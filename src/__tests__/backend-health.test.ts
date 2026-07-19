import { describe, expect, it, vi } from 'vitest';

import { collectBackendHealth } from '@/lib/backend-health';
import { BACKEND_ENVIRONMENT_REQUIREMENTS } from '@/lib/backend-environment';

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
  const withHealthyRequiredRuns = (result: QueryResult): QueryResult => {
    if (result.error || !Array.isArray(result.data)) return result;
    const rows = [...result.data];
    if (!rows.some((row) => (
      row && typeof row === 'object'
      && (row as { job_name?: unknown }).job_name === 'referral-reward-reconciliation'
    ))) {
      rows.push(
        {
          job_name: 'referral-reward-reconciliation',
          status: 'skipped',
          started_at: '2026-06-21T09:40:00.000Z',
          finished_at: '2026-06-21T09:40:01.000Z',
          duration_ms: 1000,
          skip_reason: 'no_unsettled_referral_rewards',
          error_message: null,
        },
      );
    }
    if (!rows.some((row) => (
      row && typeof row === 'object'
      && (row as { job_name?: unknown }).job_name === 'generation-model-verification'
    ))) {
      rows.push({
        job_name: 'generation-model-verification',
        status: 'succeeded',
        started_at: '2026-06-21T00:30:00.000Z',
        finished_at: '2026-06-21T00:30:01.000Z',
        duration_ms: 1000,
        skip_reason: null,
        error_message: null,
      });
    }
    return { ...result, data: rows };
  };
  const backendJobRuns = results.backend_job_runs;
  const tableResultsByName: Record<string, QueryResult | QueryResult[]> = {
    ai_usage_events: [
      { error: null, data: [] },
      { error: null, data: [] },
    ],
    generation_completion_jobs: { error: null, data: [] },
    provider_dependency_events: { error: null, data: [] },
    ...results,
    ...(backendJobRuns
      ? {
          backend_job_runs: Array.isArray(backendJobRuns)
            ? backendJobRuns.map(withHealthyRequiredRuns)
            : withHealthyRequiredRuns(backendJobRuns),
        }
      : {}),
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

const COMPLETE_BACKEND_ENVIRONMENT = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.com',
  CRON_SECRET: 'cron-secret',
  OPS_READ_SECRET: 'ops-read-secret',
  KIE_AI_API_KEY: 'kie-key',
  KIE_PROVIDER_WEBHOOK_SECRET: 'kie-provider-webhook-secret',
  KIE_WEBHOOK_HMAC_KEY: 'kie-webhook-key',
  NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp-key',
  RAZORPAY_KEY_SECRET: 'rzp-secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook-secret',
  REVENUECAT_SECRET_API_KEY: 'revenuecat-key',
  REVENUECAT_WEBHOOK_AUTH_TOKEN: 'Bearer revenuecat-webhook-secret',
  REFERRAL_ATTRIBUTION_HASH_SECRET: 'referral-hash-secret',
  APPLE_TEAM_ID: 'TEAM123456',
  ANDROID_APP_SHA256_FINGERPRINTS: 'AA:BB',
} satisfies NodeJS.ProcessEnv;

describe('collectBackendHealth', () => {
  it('returns ok when scheduled jobs recently succeeded and no generations are stalled', async () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'backend-alert-delivery',
            status: 'succeeded',
            started_at: '2026-06-21T09:59:00.000Z',
            finished_at: '2026-06-21T09:59:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: null,
          },
          {
            job_name: 'feed-maintenance',
            status: 'succeeded',
            started_at: '2026-06-21T09:20:00.000Z',
            finished_at: '2026-06-21T09:20:03.000Z',
            duration_ms: 3000,
            skip_reason: null,
            error_message: null,
          },
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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

    const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

    expect(health.issues).toEqual([]);
    expect(health.status).toBe('ok');
    expect(health.environment).toEqual({
      status: 'ok',
      configuredRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      totalRequirementCount: BACKEND_ENVIRONMENT_REQUIREMENTS.length,
      missing: [],
    });
    expect(health.catalog.activeModels).toBeGreaterThan(0);
    expect(health.scheduler).toMatchObject({
      status: 'ok',
      route: '/api/cron/backend-jobs',
      schedule: '*/10 * * * *',
      cadenceMinutes: 10,
      dailyInvocations: 144,
      dailyInvocationBudget: 180,
      logicalDailyInvocations: 505,
      coveredJobCount: 7,
      coveredJobs: expect.arrayContaining([
        expect.objectContaining({
          name: 'backend-alert-delivery',
          cadenceMinutes: 10,
          dailyInvocations: 144,
        }),
        expect.objectContaining({
          name: 'feed-maintenance',
          cadenceMinutes: 60,
          dailyInvocations: 24,
        }),
        expect.objectContaining({
          name: 'generation-completions',
          cadenceMinutes: 10,
          dailyInvocations: 144,
        }),
        expect.objectContaining({
          name: 'media-preview-repair',
          cadenceMinutes: 60,
          dailyInvocations: 24,
        }),
        expect.objectContaining({
          name: 'mobile-push-receipts',
          cadenceMinutes: 10,
          dailyInvocations: 144,
        }),
        expect.objectContaining({
          name: 'referral-reward-reconciliation',
          cadenceMinutes: 60,
          dailyInvocations: 24,
        }),
      ]),
    });
    expect(health.jobs).toHaveLength(7);
    expect(health.jobs.find((job) => job.name === 'backend-alert-delivery')).toMatchObject({
      status: 'ok',
      dailyInvocations: 144,
      expectedMaxAgeMinutes: 40,
    });
    expect(health.jobs.find((job) => job.name === 'generation-completions')).toMatchObject({
      status: 'ok',
      dailyInvocations: 144,
      expectedMaxAgeMinutes: 30,
    });
    expect(health.jobs.find((job) => job.name === 'feed-maintenance')).toMatchObject({
      status: 'ok',
      dailyInvocations: 24,
      expectedMaxAgeMinutes: 120,
    });
    expect(health.jobs.find((job) => job.name === 'media-preview-repair')).toMatchObject({
      status: 'ok',
      dailyInvocations: 24,
      expectedMaxAgeMinutes: 120,
    });
    expect(health.jobs.find((job) => job.name === 'referral-reward-reconciliation')).toMatchObject({
      status: 'ok',
      dailyInvocations: 24,
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
            job_name: 'backend-alert-delivery',
            status: 'skipped',
            started_at: '2026-06-21T09:59:00.000Z',
            finished_at: '2026-06-21T09:59:01.000Z',
            duration_ms: 1000,
            skip_reason: 'alert_delivery_not_configured',
            error_message: null,
          },
          {
            job_name: 'feed-maintenance',
            status: 'succeeded',
            started_at: '2026-06-21T09:20:00.000Z',
            finished_at: '2026-06-21T09:20:03.000Z',
            duration_ms: 3000,
            skip_reason: null,
            error_message: null,
          },
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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

  it('summarizes durable provider dependency failures and slow calls for ops alerts', async () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'backend-alert-delivery',
            status: 'skipped',
            started_at: '2026-06-21T09:59:00.000Z',
            finished_at: '2026-06-21T09:59:01.000Z',
            duration_ms: 1000,
            skip_reason: 'alert_delivery_not_configured',
            error_message: null,
          },
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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
      provider_dependency_events: {
        error: null,
        data: [
          {
            service_name: 'KIE task status',
            outcome: 'http_error',
            duration_ms: 2400,
            timeout_ms: 10_000,
            status: 502,
            created_at: '2026-06-21T09:55:00.000Z',
          },
          {
            service_name: 'KIE task status',
            outcome: 'timeout',
            duration_ms: 10_000,
            timeout_ms: 10_000,
            status: null,
            created_at: '2026-06-21T09:50:00.000Z',
          },
          {
            service_name: 'Razorpay order API',
            outcome: 'network_error',
            duration_ms: 700,
            timeout_ms: 5000,
            status: null,
            created_at: '2026-06-21T09:45:00.000Z',
          },
          {
            service_name: 'KIE media download',
            outcome: 'success',
            duration_ms: 18_000,
            timeout_ms: 60_000,
            status: 200,
            created_at: '2026-06-21T09:40:00.000Z',
          },
        ],
      },
    });

    const health = await collectBackendHealth(db.client as never, now);

    expect(health.status).toBe('warning');
    expect(health.providerDependencies).toMatchObject({
      status: 'warning',
      recentWindowMinutes: 60,
      slowAfterMs: 15_000,
      recentEventCount: 4,
      failedEventCount: 3,
      timeoutCount: 1,
      networkErrorCount: 1,
      slowCount: 1,
      averageDurationMs: 7775,
      maxDurationMs: 18_000,
      countsByOutcome: {
        http_error: 1,
        timeout: 1,
        network_error: 1,
        success: 1,
      },
      countsByService: {
        'KIE task status': 2,
        'Razorpay order API': 1,
        'KIE media download': 1,
      },
      failedByService: {
        'KIE task status': 2,
        'Razorpay order API': 1,
      },
      slowByService: {
        'KIE media download': 1,
      },
      oldestRecentEventAt: '2026-06-21T09:40:00.000Z',
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PROVIDER_DEPENDENCY_FAILURES',
        severity: 'warning',
      }),
      expect.objectContaining({
        code: 'PROVIDER_DEPENDENCY_SLOW_CALLS',
        severity: 'warning',
      }),
    ]));
    expect(db.from).toHaveBeenCalledWith('provider_dependency_events');
    expect(db.builders.provider_dependency_events[0].select).toHaveBeenCalledWith(
      'service_name,outcome,duration_ms,timeout_ms,status,created_at',
    );
    expect(db.builders.provider_dependency_events[0].gte).toHaveBeenCalledWith(
      'created_at',
      '2026-06-21T09:00:00.000Z',
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

    const health = await collectBackendHealth(
      db.client as never,
      new Date('2026-06-21T10:00:00.000Z'),
      COMPLETE_BACKEND_ENVIRONMENT,
    );

    expect(health.status).toBe('warning');
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOB_NO_RECENT_RUN', severity: 'warning' }),
    ]));
  });

  it('treats recent no-work skipped cron runs as healthy liveness', async () => {
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'backend-alert-delivery',
            status: 'skipped',
            started_at: '2026-06-21T09:59:00.000Z',
            finished_at: '2026-06-21T09:59:01.000Z',
            duration_ms: 1000,
            skip_reason: 'alert_delivery_not_configured',
            error_message: null,
          },
          {
            job_name: 'feed-maintenance',
            status: 'succeeded',
            started_at: '2026-06-21T09:20:00.000Z',
            finished_at: '2026-06-21T09:20:03.000Z',
            duration_ms: 3000,
            skip_reason: null,
            error_message: null,
          },
          {
            job_name: 'media-preview-repair',
            status: 'skipped',
            started_at: '2026-06-21T09:55:00.000Z',
            finished_at: '2026-06-21T09:55:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_repairable_media',
            error_message: null,
          },
          {
            job_name: 'mobile-push-receipts',
            status: 'skipped',
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_pending_receipts',
            error_message: null,
          },
          {
            job_name: 'generation-completions',
            status: 'skipped',
            started_at: '2026-06-21T09:58:00.000Z',
            finished_at: '2026-06-21T09:58:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_due_jobs',
            error_message: null,
          },
        ],
      },
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    });

    const health = await collectBackendHealth(
      db.client as never,
      new Date('2026-06-21T10:00:00.000Z'),
      COMPLETE_BACKEND_ENVIRONMENT,
    );

    expect(health.issues).toEqual([]);
    expect(health.status).toBe('ok');
    expect(health.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'backend-alert-delivery',
        status: 'ok',
        route: '/api/cron/backend-alert-delivery',
        schedule: '*/10 * * * *',
        cadenceMinutes: 10,
        dailyInvocations: 144,
        maxMissedRunsBeforeDegraded: 4,
        lastHealthyAt: '2026-06-21T09:59:00.000Z',
        lastSuccessAt: null,
        recentSkips: 1,
      }),
      expect.objectContaining({
        name: 'media-preview-repair',
        status: 'ok',
        route: '/api/cron/media-preview-repair',
        schedule: '0 * * * *',
        cadenceMinutes: 60,
        dailyInvocations: 24,
        maxMissedRunsBeforeDegraded: 2,
        lastHealthyAt: '2026-06-21T09:55:00.000Z',
        lastSuccessAt: null,
        recentSkips: 1,
      }),
      expect.objectContaining({
        name: 'mobile-push-receipts',
        status: 'ok',
        route: '/api/cron/mobile-push-receipts',
        schedule: '*/10 * * * *',
        cadenceMinutes: 10,
        dailyInvocations: 144,
        maxMissedRunsBeforeDegraded: 4,
        lastHealthyAt: '2026-06-21T09:50:00.000Z',
        lastSuccessAt: null,
        recentSkips: 1,
      }),
      expect.objectContaining({
        name: 'generation-completions',
        status: 'ok',
        route: '/api/cron/generation-completions',
        schedule: '*/10 * * * *',
        cadenceMinutes: 10,
        dailyInvocations: 144,
        maxMissedRunsBeforeDegraded: 3,
        lastHealthyAt: '2026-06-21T09:58:00.000Z',
        lastSuccessAt: null,
        recentSkips: 1,
      }),
    ]));
    expect(health.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOB_NO_RECENT_SUCCESS' }),
      expect.objectContaining({ code: 'JOB_STALE_SUCCESS' }),
    ]));
  });

  it('degrades when the mobile receipt job has no healthy liveness within its expected window', async () => {
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
            status: 'skipped',
            started_at: '2026-06-21T08:45:00.000Z',
            finished_at: '2026-06-21T08:45:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_pending_receipts',
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
    });

    const health = await collectBackendHealth(db.client as never, new Date('2026-06-21T10:00:00.000Z'));

    expect(health.status).toBe('degraded');
    expect(health.jobs.find((job) => job.name === 'mobile-push-receipts')).toMatchObject({
      status: 'degraded',
      expectedMaxAgeMinutes: 40,
      latestRun: expect.objectContaining({
        skipReason: 'no_pending_receipts',
      }),
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'JOB_STALE_SUCCESS',
        severity: 'degraded',
        message: expect.stringContaining('mobile-push-receipts'),
      }),
    ]));
  });

  it('warns when a scheduled job has repeated recent failures even after recovery', async () => {
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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
          {
            job_name: 'generation-completions',
            status: 'failed',
            started_at: '2026-06-21T09:40:00.000Z',
            finished_at: '2026-06-21T09:40:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: 'provider timeout',
          },
          {
            job_name: 'generation-completions',
            status: 'failed',
            started_at: '2026-06-21T09:30:00.000Z',
            finished_at: '2026-06-21T09:30:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: 'provider timeout',
          },
          {
            job_name: 'generation-completions',
            status: 'failed',
            started_at: '2026-06-21T09:20:00.000Z',
            finished_at: '2026-06-21T09:20:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: 'provider timeout',
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

    expect(health.status).toBe('warning');
    expect(health.jobs.find((job) => job.name === 'generation-completions')).toMatchObject({
      status: 'warning',
      recentFailures: 3,
      latestRun: expect.objectContaining({
        status: 'succeeded',
      }),
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'JOB_RECENT_FAILURES',
        severity: 'warning',
        message: expect.stringContaining('generation-completions'),
      }),
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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
      oldestFailedCreatedAt: '2026-06-21T09:40:00.000Z',
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
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
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
