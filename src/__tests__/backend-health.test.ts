import { describe, expect, it, vi } from 'vitest';

import { collectBackendHealth } from '@/lib/backend-health';
import { BACKEND_ENVIRONMENT_REQUIREMENTS } from '@/lib/backend-environment';
import { BACKEND_JOB_REGISTRY } from '@/lib/backend-jobs';

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
  not = vi.fn(() => this);
  range = vi.fn(() => this);

  constructor(private readonly result: QueryResult) {}

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function createClient(
  results: Record<string, QueryResult | QueryResult[]>,
  options: { withHealthyRequiredRuns?: boolean } = {},
) {
  const withHealthyRequiredRuns = (result: QueryResult): QueryResult => {
    if (result.error || !Array.isArray(result.data)) return result;
    const rows = [...result.data];
    if (!rows.some((row) => (
      row && typeof row === 'object'
      && (row as { job_name?: unknown }).job_name === 'account-deletion-resweeps'
    ))) {
      rows.push(
        {
          job_name: 'account-deletion-resweeps',
          status: 'skipped',
          started_at: '2026-06-21T09:50:00.000Z',
          finished_at: '2026-06-21T09:50:01.000Z',
          duration_ms: 1000,
          skip_reason: 'no_due_account_deletion_cleanup',
          error_message: null,
        },
      );
    }
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
  // `posts` is read twice: the remix-source sample, then the orphaned shell-post
  // probe. A test that only cares about the first passes a single result and
  // gets an empty shell probe appended, so shell-post cases are the only ones
  // that have to spell both out.
  const normalizePostsResults = (
    provided: QueryResult | QueryResult[] | undefined,
  ): QueryResult[] => {
    const emptyShellProbe: QueryResult = { error: null, data: [] };
    if (!provided) return [emptyShellProbe, emptyShellProbe];
    return Array.isArray(provided) ? provided : [provided, emptyShellProbe];
  };
  const tableResultsByName: Record<string, QueryResult | QueryResult[]> = {
    ai_usage_events: [
      { error: null, data: [] },
      { error: null, data: [] },
    ],
    generation_completion_jobs: { error: null, data: [] },
    // Two reads: unresolved video renditions, then unresolved previews.
    post_media: [
      { error: null, data: [] },
      { error: null, data: [] },
    ],
    provider_dependency_events: { error: null, data: [] },
    ...results,
    // Remix-source sample for the data-access probe, then the shell-post probe.
    // Empty by default: with no remixable posts the probe reports ok without
    // issuing its follow-up generations read, so tests that do not care about
    // it stay untouched.
    posts: normalizePostsResults(results.posts),
    ...(backendJobRuns && options.withHealthyRequiredRuns !== false
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
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.com',
  CRON_SECRET: 'cron-secret',
  OPS_READ_SECRET: 'ops-read-secret',
  KIE_AI_API_KEY: 'kie-key',
  KIE_PROVIDER_WEBHOOK_SECRET: 'kie-provider-webhook-secret',
  KIE_WEBHOOK_HMAC_KEY: 'kie-webhook-key',
  NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp_live_key',
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
            job_name: 'media-upload-reclaim',
            status: 'succeeded',
            started_at: '2026-06-21T09:46:00.000Z',
            finished_at: '2026-06-21T09:46:02.000Z',
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
      invalid: [],
    });
    expect(health.reclaimPolicy).toEqual({
      abandonedReclaimConfigured: false,
      minimumAppVersion: '0.0.1',
      abandonedReclaimEffective: false,
    });
    expect(health.catalog.activeModels).toBeGreaterThan(0);
    expect(health.catalog.schemaVersion).toBe(2);
    expect(health.scheduler).toMatchObject({
      status: 'ok',
      route: '/api/cron/backend-jobs',
      schedule: '*/10 * * * *',
      cadenceMinutes: 10,
      dailyInvocations: 144,
      dailyInvocationBudget: 180,
      logicalDailyInvocations: 651,
      coveredJobCount: 10,
      coveredJobs: expect.arrayContaining([
        expect.objectContaining({
          name: 'account-deletion-resweeps',
          cadenceMinutes: 10,
          dailyInvocations: 144,
        }),
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
    expect(health.jobs).toHaveLength(10);
    expect(health.jobs.find((job) => job.name === 'media-upload-reclaim')).toMatchObject({
      status: 'ok',
      dailyInvocations: 1,
      expectedMaxAgeMinutes: 2880,
    });
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
      'service_name,outcome,duration_ms,timeout_ms,status,created_at,model_id',
    );
    expect(db.builders.provider_dependency_events[0].gte).toHaveBeenCalledWith(
      'created_at',
      '2026-06-21T09:00:00.000Z',
    );
  });

  it('degrades when payment webhook processing failures were durably recorded', async () => {
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
            service_name: 'razorpay-webhook-processing',
            outcome: 'http_error',
            duration_ms: 0,
            timeout_ms: 0,
            status: 500,
            created_at: '2026-06-21T09:55:00.000Z',
          },
          {
            service_name: 'revenuecat-webhook-processing',
            outcome: 'http_error',
            duration_ms: 0,
            timeout_ms: 0,
            status: 503,
            created_at: '2026-06-21T09:56:00.000Z',
          },
        ],
      },
    });

    const health = await collectBackendHealth(db.client as never, now);

    // A single event is a paid transaction whose settlement did not complete,
    // so this degrades even below the generic failure-spike threshold.
    expect(health.status).toBe('degraded');
    expect(health.providerDependencies).toMatchObject({
      status: 'degraded',
      failedEventCount: 2,
      paymentWebhookProcessingFailureCount: 2,
      countsByService: {
        'razorpay-webhook-processing': 1,
        'revenuecat-webhook-processing': 1,
      },
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PAYMENT_WEBHOOK_PROCESSING_FAILURE',
        severity: 'degraded',
        message: expect.stringContaining('2 payment webhook processing failure(s)'),
      }),
    ]));
  });

  it('does not raise the payment webhook issue for non-payment provider failures', async () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const db = createClient({
      backend_job_runs: { error: null, data: [] },
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
        ],
      },
    });

    const health = await collectBackendHealth(db.client as never, now);

    expect(health.providerDependencies.paymentWebhookProcessingFailureCount).toBe(0);
    expect(health.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PAYMENT_WEBHOOK_PROCESSING_FAILURE' }),
    ]));
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
      expect.objectContaining({
        code: 'JOB_NO_RECENT_RUN',
        severity: 'warning',
        message: 'media-upload-reclaim has no recorded run in the last 48 hours.',
      }),
    ]));
  });

  it('paginates registered job runs so daily successes are not crowded out', async () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const highFrequencyRuns = Array.from({ length: 1_000 }, (_, index) => ({
      id: `frequent-${String(1_000 - index).padStart(4, '0')}`,
      job_name: 'generation-completions',
      status: 'succeeded',
      started_at: '2026-06-21T09:59:00.000Z',
      finished_at: '2026-06-21T09:59:01.000Z',
      duration_ms: 1000,
      skip_reason: null,
      error_message: null,
    }));
    const dailyAndRemainingRuns = BACKEND_JOB_REGISTRY.map((job, index) => ({
      id: `registered-${String(index).padStart(2, '0')}`,
      job_name: job.name,
      status: 'succeeded',
      started_at: '2026-06-21T09:58:00.000Z',
      finished_at: '2026-06-21T09:58:01.000Z',
      duration_ms: 1000,
      skip_reason: null,
      error_message: null,
    }));
    const db = createClient({
      backend_job_runs: [
        { error: null, data: highFrequencyRuns },
        { error: null, data: dailyAndRemainingRuns },
      ],
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    }, { withHealthyRequiredRuns: false });

    const health = await collectBackendHealth(
      db.client as never,
      now,
      COMPLETE_BACKEND_ENVIRONMENT,
    );

    expect(health.issues.filter((issue) => issue.code === 'JOB_NO_RECENT_RUN')).toEqual([]);
    expect(health.jobs.find((job) => job.name === 'media-upload-reclaim')).toMatchObject({
      status: 'ok',
      latestRun: { startedAt: '2026-06-21T09:58:00.000Z' },
    });
    expect(health.jobs.find((job) => job.name === 'generation-model-verification')).toMatchObject({
      status: 'ok',
      latestRun: { startedAt: '2026-06-21T09:58:00.000Z' },
    });

    expect(db.builders.backend_job_runs).toHaveLength(2);
    expect(db.builders.backend_job_runs[0].select).toHaveBeenCalledWith(
      'id,job_name,status,started_at,finished_at,duration_ms,skip_reason,error_message',
    );
    expect(db.builders.backend_job_runs[0].in).toHaveBeenCalledWith(
      'job_name',
      BACKEND_JOB_REGISTRY.map((job) => job.name),
    );
    expect(db.builders.backend_job_runs[0].gte).toHaveBeenCalledWith(
      'started_at',
      '2026-06-19T10:00:00.000Z',
    );
    expect(db.builders.backend_job_runs[0].order.mock.calls).toEqual([
      ['started_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(db.builders.backend_job_runs[0].range).toHaveBeenCalledWith(0, 999);
    expect(db.builders.backend_job_runs[1].order.mock.calls).toEqual([
      ['started_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(db.builders.backend_job_runs[1].range).toHaveBeenCalledWith(1_000, 1_999);
  });

  it('propagates a failure from a later job-run page', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      id: `run-${index}`,
      job_name: 'generation-completions',
      status: 'succeeded',
      started_at: '2026-06-21T09:59:00.000Z',
      finished_at: '2026-06-21T09:59:01.000Z',
      duration_ms: 1000,
      skip_reason: null,
      error_message: null,
    }));
    const db = createClient({
      backend_job_runs: [
        { error: null, data: firstPage },
        { error: new Error('job-run page two unavailable'), data: null },
      ],
      generations: [
        { error: null, data: [] },
        { error: null, data: [] },
        { error: null, data: [] },
      ],
    }, { withHealthyRequiredRuns: false });

    await expect(collectBackendHealth(db.client as never)).rejects.toThrow(
      'job-run page two unavailable',
    );

    expect(db.builders.backend_job_runs).toHaveLength(2);
    expect(db.builders.backend_job_runs[1].range).toHaveBeenCalledWith(1_000, 1_999);
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
            job_name: 'media-upload-reclaim',
            status: 'skipped',
            started_at: '2026-06-21T09:56:00.000Z',
            finished_at: '2026-06-21T09:56:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_reclaimable_media_uploads',
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
            job_name: 'operational-data-retention',
            status: 'skipped',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_prunable_operational_data',
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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
            job_name: 'operational-data-retention',
            status: 'succeeded',
            started_at: '2026-06-21T00:50:00.000Z',
            finished_at: '2026-06-21T00:50:03.000Z',
            duration_ms: 3000,
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

  it('reports a configured abandoned-reclaim flag as ineffective below the safe app floor', async () => {
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
      {
        ...COMPLETE_BACKEND_ENVIRONMENT,
        MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true',
      },
    );

    expect(health.reclaimPolicy).toEqual({
      abandonedReclaimConfigured: true,
      minimumAppVersion: '0.0.1',
      abandonedReclaimEffective: false,
    });
  });

  it('keeps a failed account deletion cleanup visible until a successful retry', async () => {
    const db = createClient({
      backend_job_runs: {
        error: null,
        data: [
          {
            job_name: 'account-deletion-resweeps',
            status: 'skipped',
            started_at: '2026-06-21T09:50:00.000Z',
            finished_at: '2026-06-21T09:50:01.000Z',
            duration_ms: 1000,
            skip_reason: 'no_due_account_deletion_cleanup',
            error_message: null,
          },
          {
            job_name: 'account-deletion-resweeps',
            status: 'failed',
            started_at: '2026-06-21T09:40:00.000Z',
            finished_at: '2026-06-21T09:40:01.000Z',
            duration_ms: 1000,
            skip_reason: null,
            error_message: 'Storage timeout',
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
    );

    expect(health.jobs.find((job) => job.name === 'account-deletion-resweeps')).toMatchObject({
      status: 'warning',
      latestRun: { status: 'skipped' },
      recentFailures: 1,
    });
    expect(health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ACCOUNT_DELETION_CLEANUP_RETRY_PENDING',
        severity: 'warning',
      }),
    ]));
  });

  describe('media pipeline', () => {
    const NOW = new Date('2026-07-29T10:00:00.000Z');

    function createMediaClient(postMedia: [unknown[], unknown[]]) {
      return createClient({
        backend_job_runs: { error: null, data: [] },
        generations: [
          { error: null, data: [] },
          { error: null, data: [] },
          { error: null, data: [] },
        ],
        post_media: [
          { error: null, data: postMedia[0] },
          { error: null, data: postMedia[1] },
        ],
      });
    }

    it('degrades when rows exhausted their attempts', async () => {
      // The silent-green state: the repair sweep filters these out, so it
      // reports "no work" every hour while no rendition will ever exist.
      const db = createMediaClient([
        [
          { rendition_status: 'failed', rendition_attempt_count: 3, created_at: '2026-07-29T09:50:00.000Z' },
        ],
        [],
      ]);

      const health = await collectBackendHealth(db.client as never, NOW);

      expect(health.status).toBe('degraded');
      expect(health.mediaPipeline).toMatchObject({
        status: 'degraded',
        renditionFailedCount: 1,
        renditionExhaustedCount: 1,
      });
      expect(health.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: 'degraded',
          code: 'MEDIA_RENDITION_ATTEMPTS_EXHAUSTED',
        }),
      ]));
    });

    it('only warns while retries remain', async () => {
      const db = createMediaClient([
        [
          { rendition_status: 'failed', rendition_attempt_count: 1, created_at: '2026-07-29T09:50:00.000Z' },
        ],
        [],
      ]);

      const health = await collectBackendHealth(db.client as never, NOW);

      expect(health.mediaPipeline).toMatchObject({
        status: 'warning',
        renditionFailedCount: 1,
        renditionExhaustedCount: 0,
      });
      expect(health.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'MEDIA_RENDITION_FAILURES' }),
      ]));
    });

    it('flags an exhausted preview backlog separately', async () => {
      const db = createMediaClient([
        [],
        [
          { preview_status: 'failed', preview_attempt_count: 3, created_at: '2026-07-29T09:50:00.000Z' },
        ],
      ]);

      const health = await collectBackendHealth(db.client as never, NOW);

      expect(health.mediaPipeline).toMatchObject({
        status: 'degraded',
        previewExhaustedCount: 1,
      });
      expect(health.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'MEDIA_PREVIEW_ATTEMPTS_EXHAUSTED' }),
      ]));
    });

    it('warns when the backlog has outlived several repair windows', async () => {
      const db = createMediaClient([
        [
          { rendition_status: 'pending', rendition_attempt_count: 0, created_at: '2026-07-28T10:00:00.000Z' },
        ],
        [],
      ]);

      const health = await collectBackendHealth(db.client as never, NOW);

      expect(health.mediaPipeline).toMatchObject({
        status: 'warning',
        renditionPendingCount: 1,
        oldestUnresolvedRenditionAt: '2026-07-28T10:00:00.000Z',
      });
      expect(health.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'MEDIA_RENDITION_BACKLOG_STALE' }),
      ]));
    });

    it('stays ok on a freshly requeued backlog', async () => {
      // The state the reset migration leaves behind. It must not block the
      // release gate, which rejects anything worse than warning.
      const db = createMediaClient([
        [
          { rendition_status: 'pending', rendition_attempt_count: 0, created_at: '2026-07-29T09:55:00.000Z' },
        ],
        [],
      ]);

      const health = await collectBackendHealth(db.client as never, NOW);

      expect(health.mediaPipeline).toMatchObject({ status: 'ok', renditionPendingCount: 1 });
      expect(health.issues.filter((issue) => issue.code.startsWith('MEDIA_'))).toEqual([]);
    });

    it('reads only unresolved rows so failures cannot be crowded out', async () => {
      const db = createMediaClient([[], []]);

      await collectBackendHealth(db.client as never, NOW);

      expect(db.builders.post_media[0].eq).toHaveBeenCalledWith('media_kind', 'video');
      expect(db.builders.post_media[0].in).toHaveBeenCalledWith(
        'rendition_status',
        ['pending', 'processing', 'failed'],
      );
      expect(db.builders.post_media[1].in).toHaveBeenCalledWith(
        'preview_status',
        ['pending', 'processing', 'failed'],
      );
    });
  });

  describe('data access contract', () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    // Three generations reads happen before the remix-source probe: recent,
    // stalled, and pending-without-provider-task.
    const GENERATION_READS_BEFORE_PROBE = [
      { error: null, data: [] },
      { error: null, data: [] },
      { error: null, data: [] },
    ];
    const remixablePost = {
      id: 'post-1',
      user_id: 'creator-1',
      generation_id: 'gen-1',
    };
    const readableSource = {
      id: 'gen-1',
      user_id: 'creator-1',
      is_public: true,
    };

    function dataAccessIssues(health: Awaited<ReturnType<typeof collectBackendHealth>>) {
      return health.issues.filter((issue) => issue.code.startsWith('DATA_ACCESS_'));
    }

    it('degrades when the privileged remix projection cannot be read', async () => {
      // The exact production regression: the 2026-07-26 hardening revoked the
      // columns this projection names, so the read fails with 42501.
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [remixablePost] },
        generations: [
          ...GENERATION_READS_BEFORE_PROBE,
          { error: new Error('permission denied for table generations'), data: null },
        ],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toEqual({
        status: 'degraded',
        remixSourcesSampled: 1,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: 0,
        projectionReadError: 'permission denied for table generations',
      });
      expect(dataAccessIssues(health)).toEqual([{
        severity: 'degraded',
        code: 'DATA_ACCESS_REMIX_PROJECTION_UNREADABLE',
        message:
          'The privileged generations projection behind remix could not be read: '
          + 'permission denied for table generations. Check grants and policies on public.generations.',
      }]);
      // Degraded is what production-release refuses to promote on.
      expect(health.status).toBe('degraded');
    });

    it('degrades when public posts exist but no source resolves', async () => {
      // The five-day silent break: rows are public and present, the read simply
      // returns nothing, and every Remix button 404s.
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [remixablePost, { ...remixablePost, id: 'post-2', generation_id: 'gen-2' }] },
        generations: [...GENERATION_READS_BEFORE_PROBE, { error: null, data: [] }],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toMatchObject({
        status: 'degraded',
        remixSourcesSampled: 2,
        remixSourcesResolved: 0,
      });
      expect(dataAccessIssues(health)[0]).toMatchObject({
        severity: 'degraded',
        code: 'DATA_ACCESS_REMIX_SOURCE_UNRESOLVABLE',
      });
      expect(health.status).toBe('degraded');
    });

    it('names the full remix projection so a future revoke is caught', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [remixablePost] },
        generations: [...GENERATION_READS_BEFORE_PROBE, { error: null, data: [readableSource] }],
      });

      await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(db.builders.generations[3].select).toHaveBeenCalledWith(
        'id, user_id, is_public, share_input_media_for_remix, category, prompt, workflow_settings',
      );
      expect(db.builders.generations[3].in).toHaveBeenCalledWith('id', ['gen-1']);
      // Only the posts a viewer could actually press Remix on.
      expect(db.builders.posts[0].eq).toHaveBeenCalledWith('visibility', 'public');
      expect(db.builders.posts[0].eq).toHaveBeenCalledWith('review_status', 'visible');
      expect(db.builders.posts[0].is).toHaveBeenCalledWith('archived_at', null);
    });

    it('stays ok when sources resolve through the remix gate', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [remixablePost] },
        generations: [...GENERATION_READS_BEFORE_PROBE, { error: null, data: [readableSource] }],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toEqual({
        status: 'ok',
        remixSourcesSampled: 1,
        remixSourcesResolved: 1,
        remixSourcesGateBlocked: 0,
        projectionReadError: null,
      });
      expect(dataAccessIssues(health)).toEqual([]);
    });

    it('warns rather than degrades when only some sources are missing', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: {
          error: null,
          data: [remixablePost, { id: 'post-2', user_id: 'creator-1', generation_id: 'gen-2' }],
        },
        generations: [...GENERATION_READS_BEFORE_PROBE, { error: null, data: [readableSource] }],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toMatchObject({
        status: 'warning',
        remixSourcesSampled: 2,
        remixSourcesResolved: 1,
      });
      expect(dataAccessIssues(health)[0]).toMatchObject({
        severity: 'warning',
        code: 'DATA_ACCESS_REMIX_SOURCE_MISSING',
      });
      // A warning must not block a release the way degraded does.
      expect(health.status).not.toBe('degraded');
    });

    it('counts a source that fails the gate separately from one that cannot be read', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [remixablePost] },
        generations: [
          ...GENERATION_READS_BEFORE_PROBE,
          { error: null, data: [{ ...readableSource, is_public: false }] },
        ],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toMatchObject({
        remixSourcesSampled: 1,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: 1,
      });
    });

    it('reports ok with an empty sample rather than failing a fresh environment', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        posts: { error: null, data: [] },
        generations: GENERATION_READS_BEFORE_PROBE,
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.dataAccess).toEqual({
        status: 'ok',
        remixSourcesSampled: 0,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: 0,
        projectionReadError: null,
      });
      // No remixable posts means no follow-up read at all.
      expect(db.builders.generations).toHaveLength(3);
      expect(dataAccessIssues(health)).toEqual([]);
    });
  });

  describe('orphaned shell posts', () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    // Recent, stalled, and pending-without-provider-task -- the three
    // generations reads in the main batch. No remixable posts, so the
    // data-access probe never issues its fourth.
    const SHELL_PROBE_GENERATION_READS = [
      { error: null, data: [] },
      { error: null, data: [] },
      { error: null, data: [] },
    ];
    const shellPost = {
      id: 'post-shell-1',
      visibility: 'private',
      created_at: '2026-06-21T06:00:00.000Z',
    };

    function shellPostIssues(health: Awaited<ReturnType<typeof collectBackendHealth>>) {
      return health.issues.filter((issue) => (
        issue.code === 'ORPHANED_MEDIA_SHELL_POSTS' || issue.code === 'SHELL_POST_PROBE_FAILED'
      ));
    }

    it('warns when media posts survive without their media rows', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        generations: SHELL_PROBE_GENERATION_READS,
        posts: [
          { error: null, data: [] },
          { error: null, data: [shellPost, { ...shellPost, id: 'post-shell-2', created_at: '2026-06-21T08:00:00.000Z' }] },
        ],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.postIntegrity).toEqual({
        status: 'warning',
        staleAfterMinutes: 60,
        shellPostCount: 2,
        oldestShellPostCreatedAt: '2026-06-21T06:00:00.000Z',
        sampleTruncated: false,
        probeReadError: null,
      });
      expect(shellPostIssues(health)).toEqual([{
        severity: 'warning',
        code: 'ORPHANED_MEDIA_SHELL_POSTS',
        message:
          '2 media post(s) older than 60 minutes have no media rows; '
          + 'a compensating delete failed after the media write did.',
      }]);
      // Cruft an operator clears, not a release blocker.
      expect(health.status).toBe('warning');
    });

    it('degrades when the probe itself cannot be read', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        generations: SHELL_PROBE_GENERATION_READS,
        posts: [
          { error: null, data: [] },
          { error: new Error('permission denied for table post_media'), data: null },
        ],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      expect(health.postIntegrity).toMatchObject({
        status: 'degraded',
        shellPostCount: 0,
        probeReadError: 'permission denied for table post_media',
      });
      expect(shellPostIssues(health)[0]).toMatchObject({
        severity: 'degraded',
        code: 'SHELL_POST_PROBE_FAILED',
      });
    });

    it('excludes generation-backed and pre-gallery posts from the probe', async () => {
      const db = createClient({
        backend_job_runs: { error: null, data: [] },
        generations: SHELL_PROBE_GENERATION_READS,
        posts: [
          { error: null, data: [] },
          { error: null, data: [] },
        ],
      });

      const health = await collectBackendHealth(db.client as never, now, COMPLETE_BACKEND_ENVIRONMENT);

      const probe = db.builders.posts[1];
      expect(probe.in).toHaveBeenCalledWith('post_format', ['media', 'mixed']);
      // Generation-backed posts keep media on posts.showcase_asset_path, and
      // pre-gallery posts predate post_media entirely -- both legitimately have
      // zero rows and would otherwise be reported as permanent cruft.
      expect(probe.is).toHaveBeenCalledWith('generation_id', null);
      expect(probe.is).toHaveBeenCalledWith('post_media', null);
      // The gallery migration's own timestamp, not midnight of that day --
      // widening to midnight would flag legacy same-day posts as shells.
      expect(probe.gte).toHaveBeenCalledWith('created_at', '2026-06-09T09:40:06.000Z');
      // One hour before `now`: anything younger may still be mid-publish.
      expect(probe.lt).toHaveBeenCalledWith('created_at', '2026-06-21T09:00:00.000Z');

      expect(health.postIntegrity).toMatchObject({ status: 'ok', shellPostCount: 0 });
      expect(shellPostIssues(health)).toEqual([]);
    });
  });
});
