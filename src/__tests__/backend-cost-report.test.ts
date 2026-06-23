import { describe, expect, it, vi } from 'vitest';

import {
  buildBackendCostBudgetPolicy,
  collectBackendCostReport,
} from '@/lib/backend-cost-report';

type QueryResult = {
  data: unknown[] | null;
  error: Error | null;
};

class FakeQueryBuilder {
  select = vi.fn(() => this);
  gte = vi.fn(() => this);
  in = vi.fn(() => this);
  order = vi.fn(() => this);
  limit = vi.fn(() => this);

  constructor(private readonly result: QueryResult) {}

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function createClient(results: Record<string, QueryResult>) {
  const builders: Record<string, FakeQueryBuilder[]> = {};
  const fromTable = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table query: ${table}`);
    const builder = new FakeQueryBuilder(result);
    builders[table] = [...(builders[table] ?? []), builder];
    return builder;
  });
  const fromStorageTable = vi.fn((table: string) => {
    const result = results[`storage.${table}`];
    if (!result) throw new Error(`Unexpected storage table query: ${table}`);
    const builder = new FakeQueryBuilder(result);
    builders[`storage.${table}`] = [...(builders[`storage.${table}`] ?? []), builder];
    return builder;
  });

  return {
    client: {
      from: fromTable,
      schema: vi.fn((schema: string) => {
        if (schema !== 'storage') throw new Error(`Unexpected schema: ${schema}`);
        return { from: fromStorageTable };
      }),
    },
    fromTable,
    fromStorageTable,
    builders,
  };
}

describe('collectBackendCostReport', () => {
  it('loads budget thresholds from environment variables and keeps degraded limits at or above warning limits', () => {
    const policy = buildBackendCostBudgetPolicy({}, {
      BACKEND_BUDGET_GENERATION_CREDITS_WARNING: '42',
      BACKEND_BUDGET_GENERATION_CREDITS_DEGRADED: '41',
      BACKEND_BUDGET_QUOTE_REQUESTS_WARNING: '20',
      BACKEND_BUDGET_QUOTE_REQUESTS_DEGRADED: '10',
      BACKEND_BUDGET_STORAGE_BYTES_WARNING: 'not-a-number',
      BACKEND_BUDGET_STORAGE_BYTES_DEGRADED: '4096',
    });

    expect(policy).toMatchObject({
      generationCreditCostWarning: 42,
      generationCreditCostDegraded: 42,
      quoteRequestsWarning: 20,
      quoteRequestsDegraded: 20,
      storageGrowthWarningBytes: 1024 * 1024 * 1024,
      storageGrowthDegradedBytes: 1024 * 1024 * 1024,
    });
  });

  it('summarizes spend, provider pressure, storage growth, and quote/read pressure without querying raw subject keys', async () => {
    const now = new Date('2026-06-22T10:00:00.000Z');
    const db = createClient({
      generations: {
        error: null,
        data: [
          {
            status: 'succeeded',
            model: 'nano-banana-2',
            cost: 8,
            created_at: '2026-06-22T09:55:00.000Z',
            output_url: 'generated_images/user/image-1.png',
          },
          {
            status: 'failed',
            model: 'veo-3.1',
            cost: '12',
            created_at: '2026-06-22T09:40:00.000Z',
            output_url: null,
          },
          {
            status: 'processing',
            model: null,
            cost: 3,
            created_at: '2026-06-22T09:20:00.000Z',
            output_url: null,
          },
        ],
      },
      ai_usage_events: {
        error: null,
        data: [
          {
            feature: 'prompt_enhancement',
            status: 'succeeded',
            cost: 2,
            created_at: '2026-06-22T09:45:00.000Z',
          },
          {
            feature: 'workflow_blueprint',
            status: 'failed',
            cost: 5,
            created_at: '2026-06-22T09:35:00.000Z',
          },
        ],
      },
      provider_dependency_events: {
        error: null,
        data: [
          {
            service_name: 'KIE task status',
            outcome: 'timeout',
            duration_ms: 10_000,
            created_at: '2026-06-22T09:40:00.000Z',
          },
          {
            service_name: 'KIE media download',
            outcome: 'success',
            duration_ms: 18_000,
            created_at: '2026-06-22T09:20:00.000Z',
          },
        ],
      },
      backend_rate_limits: {
        error: null,
        data: [
          {
            scope: 'generation-model:quote',
            request_count: 120,
            window_start: '2026-06-22T09:50:00.000Z',
            updated_at: '2026-06-22T09:55:00.000Z',
          },
          {
            scope: 'generation-model:quote',
            request_count: 70,
            window_start: '2026-06-22T09:40:00.000Z',
            updated_at: '2026-06-22T09:45:00.000Z',
          },
          {
            scope: 'media-read:sign',
            request_count: 450,
            window_start: '2026-06-22T09:30:00.000Z',
            updated_at: '2026-06-22T09:35:00.000Z',
          },
          {
            scope: 'workflow-asset-upload:read-url',
            request_count: 25,
            window_start: '2026-06-22T09:20:00.000Z',
            updated_at: '2026-06-22T09:25:00.000Z',
          },
        ],
      },
      'storage.objects': {
        error: null,
        data: [
          {
            bucket_id: 'generated_images',
            name: 'user/image-1.png',
            metadata: { size: 2_000_000 },
            created_at: '2026-06-22T09:59:00.000Z',
          },
          {
            bucket_id: 'generated_videos',
            name: 'user/video-1.mp4',
            metadata: { size: 15_000_000 },
            created_at: '2026-06-22T09:10:00.000Z',
          },
          {
            bucket_id: 'generation_inputs',
            name: 'user/input.png',
            metadata: { size: '1000000' },
            created_at: '2026-06-22T08:30:00.000Z',
          },
        ],
      },
    });

    const report = await collectBackendCostReport(db.client as never, now);

    expect(report.status).toBe('warning');
    expect(report.window).toEqual({
      recentHours: 24,
      since: '2026-06-21T10:00:00.000Z',
    });
    expect(report.generationSpend).toMatchObject({
      recentRuns: 3,
      recentCreditCost: 23,
      failedPaidCount: 1,
      failedPaidCreditCost: 12,
      byStatus: { succeeded: 8, failed: 12, processing: 3 },
      byModel: { 'nano-banana-2': 8, 'veo-3.1': 12, unknown: 3 },
      completedOutputCount: 1,
    });
    expect(report.aiUsageSpend).toMatchObject({
      recentEvents: 2,
      recentCreditCost: 7,
      failedCount: 1,
      byFeature: { prompt_enhancement: 2, workflow_blueprint: 5 },
    });
    expect(report.providerDependencies).toMatchObject({
      recentEvents: 2,
      failedCount: 1,
      slowCount: 1,
      maxDurationMs: 18_000,
      byService: { 'KIE task status': 1, 'KIE media download': 1 },
    });
    expect(report.rateLimitPressure).toMatchObject({
      totalRequests: 665,
      quoteRequests: 190,
      mediaReadRequests: 475,
      maxWindowRequestCount: 450,
      byScope: {
        'generation-model:quote': 190,
        'media-read:sign': 450,
        'workflow-asset-upload:read-url': 25,
      },
    });
    expect(report.storageGrowth).toMatchObject({
      recentObjectCount: 3,
      recentBytes: 18_000_000,
      largestObjectBytes: 15_000_000,
      bytesByBucket: {
        generated_images: 2_000_000,
        generated_videos: 15_000_000,
        generation_inputs: 1_000_000,
      },
      objectsByBucket: {
        generated_images: 1,
        generated_videos: 1,
        generation_inputs: 1,
      },
    });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FAILED_PAID_GENERATIONS', severity: 'warning' }),
    ]));
    expect(db.builders.generations[0].select).toHaveBeenCalledWith('status,model,cost,created_at,output_url');
    expect(db.builders.ai_usage_events[0].select).toHaveBeenCalledWith('feature,status,cost,created_at');
    expect(db.builders.provider_dependency_events[0].select).toHaveBeenCalledWith('service_name,outcome,duration_ms,created_at');
    expect(db.builders.backend_rate_limits[0].select).toHaveBeenCalledWith('scope,request_count,window_start,updated_at');
    expect(db.builders.backend_rate_limits[0].select).not.toHaveBeenCalledWith(expect.stringContaining('subject_key'));
    expect(db.builders['storage.objects'][0].select).toHaveBeenCalledWith('bucket_id,name,metadata,created_at');
    expect(db.builders['storage.objects'][0].in).toHaveBeenCalledWith('bucket_id', [
      'generated_images',
      'generated_videos',
      'generated_audio',
      'generation_inputs',
    ]);
  });

  it('applies configurable budget thresholds for spend, quote pressure, media reads, failed paid generations, and storage growth', async () => {
    const now = new Date('2026-06-22T10:00:00.000Z');
    const db = createClient({
      generations: {
        error: null,
        data: [
          {
            status: 'succeeded',
            model: 'nano-banana-2',
            cost: 51,
            created_at: '2026-06-22T09:55:00.000Z',
            output_url: 'generated_images/user/image-1.png',
          },
          {
            status: 'failed',
            model: 'veo-3.1',
            cost: 7,
            created_at: '2026-06-22T09:40:00.000Z',
            output_url: null,
          },
        ],
      },
      ai_usage_events: {
        error: null,
        data: [
          {
            feature: 'workflow_blueprint',
            status: 'succeeded',
            cost: 11,
            created_at: '2026-06-22T09:35:00.000Z',
          },
        ],
      },
      provider_dependency_events: {
        error: null,
        data: [],
      },
      backend_rate_limits: {
        error: null,
        data: [
          {
            scope: 'generation-model:quote',
            request_count: 8,
            window_start: '2026-06-22T09:50:00.000Z',
            updated_at: '2026-06-22T09:55:00.000Z',
          },
          {
            scope: 'media-read:sign',
            request_count: 9,
            window_start: '2026-06-22T09:30:00.000Z',
            updated_at: '2026-06-22T09:35:00.000Z',
          },
        ],
      },
      'storage.objects': {
        error: null,
        data: [
          {
            bucket_id: 'generated_images',
            name: 'user/image-1.png',
            metadata: { size: 6_000 },
            created_at: '2026-06-22T09:59:00.000Z',
          },
        ],
      },
    });

    const report = await collectBackendCostReport(db.client as never, now, {
      budgetPolicy: {
        generationCreditCostWarning: 50,
        generationCreditCostDegraded: 100,
        aiUsageCreditCostWarning: 10,
        aiUsageCreditCostDegraded: 20,
        failedPaidGenerationDegradedCredits: 5,
        quoteRequestsWarning: 5,
        quoteRequestsDegraded: 20,
        mediaReadRequestsWarning: 8,
        mediaReadRequestsDegraded: 30,
        storageGrowthWarningBytes: 5_000,
        storageGrowthDegradedBytes: 10_000,
      },
    });

    expect(report.budgetPolicy).toMatchObject({
      generationCreditCostWarning: 50,
      generationCreditCostDegraded: 100,
      aiUsageCreditCostWarning: 10,
      aiUsageCreditCostDegraded: 20,
      failedPaidGenerationDegradedCredits: 5,
      quoteRequestsWarning: 5,
      quoteRequestsDegraded: 20,
      mediaReadRequestsWarning: 8,
      mediaReadRequestsDegraded: 30,
      storageGrowthWarningBytes: 5_000,
      storageGrowthDegradedBytes: 10_000,
    });
    expect(report.status).toBe('degraded');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GENERATION_SPEND_ELEVATED', severity: 'warning' }),
      expect.objectContaining({ code: 'AI_USAGE_SPEND_ELEVATED', severity: 'warning' }),
      expect.objectContaining({ code: 'FAILED_PAID_GENERATION_SPIKE', severity: 'degraded' }),
      expect.objectContaining({ code: 'QUOTE_PRESSURE_ELEVATED', severity: 'warning' }),
      expect.objectContaining({ code: 'MEDIA_READ_PRESSURE_ELEVATED', severity: 'warning' }),
      expect.objectContaining({ code: 'STORAGE_GROWTH_ELEVATED', severity: 'warning' }),
    ]));
  });
});
