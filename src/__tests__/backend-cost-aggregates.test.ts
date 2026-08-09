import { describe, expect, it, vi } from 'vitest';

import { collectBackendCostReport } from '@/lib/backend-cost-report';
import { normalizeBackendCostAggregates } from '@/lib/backend-cost-aggregates';

/**
 * F15a's differential test.
 *
 * The audit was explicit about the way this change goes wrong: "converting them
 * makes the builders thin adapters and moves the arithmetic into SQL, where
 * those tests no longer reach it — so done carelessly the change *reduces*
 * coverage of the logic while fixing a truncation that is not occurring." The
 * prescribed guard was to "keep a raw-row path in the tests to compare against,
 * so the SQL is validated against the JS it replaces rather than simply
 * replacing it."
 *
 * So this file pins the two halves of a chain:
 *
 *   raw rows --[ get_backend_cost_aggregates ]--> aggregate payload   (pgTAP)
 *   aggregate payload --> report  ==  raw rows --> report             (here)
 *
 * AGGREGATE_PAYLOAD below is not hand-computed. It is the verbatim output of
 * `public.get_backend_cost_aggregates(now() - interval '24 hours', ...)` run
 * against a local Postgres seeded with exactly the rows in RAW_ROWS, so a
 * mismatch means the SQL and the JS genuinely disagree — not that someone
 * mis-transcribed an expectation. `supabase/tests/database/
 * backend_cost_aggregates.test.sql` holds the same fixture and asserts the
 * database end of the chain.
 *
 * If you change either implementation, regenerate this payload rather than
 * editing it by hand.
 */

const NOW = new Date('2026-08-09T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * The rows the aggregate payload was generated from. Every entry exists to hit
 * a semantic where the JS builders do something non-obvious — see the inline
 * notes — so neither implementation can pass this by accident.
 */
const RAW_ROWS = {
  generations: [
    { status: 'succeeded', model: 'nano-banana-2', cost: 8, created_at: hoursAgo(1), output_url: 'generated_images/a.png' },
    // Empty string is falsy in JS, so this must NOT reach completedOutputCount.
    { status: 'succeeded', model: 'nano-banana-2', cost: 3, created_at: hoursAgo(2), output_url: '' },
    { status: 'completed', model: 'veo-3.1', cost: 25, created_at: hoursAgo(3), output_url: 'generated_videos/b.mp4' },
    { status: 'failed', model: 'veo-3.1', cost: 12, created_at: hoursAgo(4), output_url: null },
    // Failed but free: a failedPaid* figure must exclude it.
    { status: 'failed', model: 'veo-3.1', cost: 0, created_at: hoursAgo(5), output_url: null },
    // Null status/model group under 'unknown'; a negative cost clamps to 0.
    { status: null, model: null, cost: -50, created_at: hoursAgo(6), output_url: null },
  ],
  ai_usage_events: [
    { feature: 'prompt-assist', status: 'succeeded', cost: 4, created_at: hoursAgo(1) },
    { feature: 'prompt-assist', status: 'failed', cost: 6, created_at: hoursAgo(2) },
    { feature: 'caption', status: 'succeeded', cost: 0, created_at: hoursAgo(3) },
  ],
  provider_dependency_events: [
    { service_name: 'kie', outcome: 'success', duration_ms: 900, created_at: hoursAgo(1), model_id: 'veo-3.1' },
    { service_name: 'kie', outcome: 'http_error', duration_ms: 1200, created_at: hoursAgo(2), model_id: 'veo-3.1' },
    { service_name: 'kie', outcome: 'timeout', duration_ms: 30_000, created_at: hoursAgo(3), model_id: 'veo-3.1' },
    // Slow but successful: slowCount counts it, failedCount does not.
    { service_name: 'kie', outcome: 'success', duration_ms: 15_000, created_at: hoursAgo(4), model_id: null },
    // A blank model id is excluded from the per-model breakdowns entirely
    // rather than bucketed under a placeholder that would collect every
    // payment and push call and then trip the model alert thresholds.
    { service_name: 'razorpay', outcome: 'success', duration_ms: 300, created_at: hoursAgo(5), model_id: '   ' },
    { service_name: 'razorpay', outcome: 'network_error', duration_ms: 400, created_at: hoursAgo(6), model_id: null },
  ],
  backend_rate_limits: [
    { scope: 'generation-model:quote', request_count: 40, window_start: hoursAgo(1), updated_at: hoursAgo(1) },
    { scope: 'generation-model:quote', request_count: 60, window_start: hoursAgo(2), updated_at: hoursAgo(2) },
    { scope: 'media-read:sign', request_count: 130, window_start: hoursAgo(1), updated_at: hoursAgo(1) },
    { scope: 'showcase-preview:read-url', request_count: 25, window_start: hoursAgo(2), updated_at: hoursAgo(2) },
    { scope: 'post-comments:list', request_count: 9, window_start: hoursAgo(3), updated_at: hoursAgo(3) },
  ],
  'storage.objects': [
    { bucket_id: 'generated_images', name: 'f15a/a.png', metadata: { size: 1024 }, created_at: hoursAgo(1) },
    // A numeric string parses in JS, so it must parse in SQL too.
    { bucket_id: 'generated_images', name: 'f15a/b.png', metadata: { size: '2048' }, created_at: hoursAgo(2) },
    // Non-numeric, missing, and non-object metadata all read as 0 bytes.
    { bucket_id: 'generated_images', name: 'f15a/c.png', metadata: { size: 'not-a-number' }, created_at: hoursAgo(3) },
    { bucket_id: 'generated_videos', name: 'f15a/d.mp4', metadata: { mimetype: 'video/mp4' }, created_at: hoursAgo(4) },
    { bucket_id: 'generated_videos', name: 'f15a/e.mp4', metadata: 'scalar', created_at: hoursAgo(5) },
    { bucket_id: 'generated_videos', name: 'f15a/f.mp4', metadata: { size: 9_000_000 }, created_at: hoursAgo(6) },
  ],
};

/** Verbatim `get_backend_cost_aggregates` output for RAW_ROWS. Regenerate; do not edit. */
const AGGREGATE_PAYLOAD = {
  generations: {
    rowCount: 6,
    recentCreditCost: 48,
    failedPaidCount: 1,
    failedPaidCreditCost: 12,
    completedOutputCount: 2,
    byStatus: { failed: 12, unknown: 0, completed: 25, succeeded: 11 },
    byModel: { unknown: 0, 'veo-3.1': 37, 'nano-banana-2': 11 },
  },
  aiUsage: {
    rowCount: 3,
    recentCreditCost: 10,
    failedCount: 1,
    byFeature: { caption: 0, 'prompt-assist': 10 },
    byStatus: { failed: 6, succeeded: 4 },
  },
  providerDependencies: {
    rowCount: 6,
    failedCount: 3,
    slowCount: 2,
    maxDurationMs: 30_000,
    byService: { kie: 4, razorpay: 2 },
    failuresByService: { kie: 2, razorpay: 1 },
    timeoutsByService: { kie: 1 },
    byModel: { 'veo-3.1': 3 },
    failuresByModel: { 'veo-3.1': 2 },
    timeoutsByModel: { 'veo-3.1': 1 },
  },
  rateLimits: {
    rowCount: 5,
    totalRequests: 264,
    maxWindowRequestCount: 130,
    byScope: {
      'media-read:sign': 130,
      'post-comments:list': 9,
      'generation-model:quote': 100,
      'showcase-preview:read-url': 25,
    },
  },
  storage: {
    rowCount: 6,
    recentBytes: 9_003_072,
    largestObjectBytes: 9_000_000,
    bytesByBucket: { generated_images: 3072, generated_videos: 9_000_000 },
    objectsByBucket: { generated_images: 3, generated_videos: 3 },
  },
};

type QueryResult = { data: unknown[] | null; error: unknown | null };

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

/**
 * `aggregates: null` simulates a database without migration 20260809200000 —
 * the RPC errors and the collector falls back to downloading rows.
 */
function createClient(aggregates: unknown | null) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn !== 'get_backend_cost_aggregates') {
      return { data: null, error: { message: `unexpected rpc: ${fn}` } };
    }
    if (aggregates === null) {
      return { data: null, error: { message: 'function does not exist' } };
    }
    return { data: aggregates, error: null };
  });

  const from = vi.fn((table: string) => {
    const rows = (RAW_ROWS as Record<string, unknown[]>)[table];
    // Tables outside the five cost sources (attempt counters, completion jobs)
    // are unavailable on purpose: their collectors are fail-soft, and this test
    // is about the five.
    if (!rows) return new FakeQueryBuilder({ data: null, error: { message: 'unavailable' } });
    return new FakeQueryBuilder({ data: rows, error: null });
  });

  return {
    rpc,
    from,
    schema: vi.fn((schema: string) => ({
      from: (table: string) => {
        const rows = (RAW_ROWS as Record<string, unknown[]>)[`${schema}.${table}`];
        if (!rows) return new FakeQueryBuilder({ data: null, error: { message: 'unavailable' } });
        return new FakeQueryBuilder({ data: rows, error: null });
      },
    })),
  };
}

describe('F15a database-side cost aggregates', () => {
  it('produces byte-for-byte the same report as the raw-row path it replaces', async () => {
    // The whole point of the item: the arithmetic moved, the answers did not.
    const fromAggregates = await collectBackendCostReport(createClient(AGGREGATE_PAYLOAD) as never, NOW);
    const fromRawRows = await collectBackendCostReport(createClient(null) as never, NOW);

    expect(fromAggregates.sampling.mode).toBe('aggregate');
    expect(fromRawRows.sampling.mode).toBe('raw-rows');

    // Sampling is the one field that legitimately differs — it describes how
    // the numbers were obtained, not what they are. Everything else must match.
    const withoutSampling = (report: Awaited<ReturnType<typeof collectBackendCostReport>>) =>
      Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'sampling'));

    expect(withoutSampling(fromAggregates)).toEqual(withoutSampling(fromRawRows));
  });

  it('derives the quote and media-read splits in TypeScript, not in SQL', async () => {
    // The SQL returns byScope and nothing else about scopes. Which scopes count
    // as a media read is product policy that changes whenever a route is added,
    // and MEDIA_READ_RATE_LIMIT_SCOPES is the single place that knows. If this
    // ever has to be edited in a migration, the policy has forked.
    const report = await collectBackendCostReport(createClient(AGGREGATE_PAYLOAD) as never, NOW);

    expect(report.rateLimitPressure).toMatchObject({
      totalRequests: 264,
      quoteRequests: 100,
      // media-read:sign 130 + showcase-preview:read-url 25; post-comments:list
      // is not a media read and must not be counted.
      mediaReadRequests: 155,
      maxWindowRequestCount: 130,
    });
  });

  it('reports the exact population and never truncates on the aggregate path', async () => {
    const report = await collectBackendCostReport(createClient(AGGREGATE_PAYLOAD) as never, NOW);

    expect(report.sampling.truncated).toBe(false);
    // limit 0 says "no cap applied", rather than restating 5000 as though a cap
    // were still in play.
    expect(report.sampling.limit).toBe(0);
    expect(report.sampling.sources).toEqual([
      { source: 'generations', rows: 6, truncated: false },
      { source: 'ai_usage_events', rows: 3, truncated: false },
      { source: 'provider_dependency_events', rows: 6, truncated: false },
      { source: 'backend_rate_limits', rows: 5, truncated: false },
      { source: 'storage.objects', rows: 6, truncated: false },
    ]);
    expect(report.issues.map((issue) => issue.code)).not.toContain('COST_REPORT_TRUNCATED');
  });

  it('does not raise an issue merely because the aggregate function is missing', async () => {
    // The fallback is exact whenever it does not truncate, so alerting on it
    // would fire on every collection against a database that simply has not
    // applied the migration — every local stack included. sampling.mode carries
    // the state as data; truncation is the thing that is actually wrong.
    const report = await collectBackendCostReport(createClient(null) as never, NOW);

    expect(report.sampling.mode).toBe('raw-rows');
    expect(report.issues.map((issue) => issue.code)).not.toContain('COST_REPORT_TRUNCATED');
    expect(report.issues.map((issue) => issue.code)).not.toContain('COST_REPORT_AGGREGATES_UNAVAILABLE');
  });

  it('falls back rather than reporting zeroes when the payload is not an object', () => {
    // A zeroed report is indistinguishable from a genuinely quiet window, which
    // is the same silent optimism F15a exists to remove.
    expect(normalizeBackendCostAggregates(null)).toBeNull();
    expect(normalizeBackendCostAggregates('{}')).toBeNull();
    expect(normalizeBackendCostAggregates([])).toBeNull();
  });

  it('clamps negative and non-numeric aggregate values instead of propagating them', () => {
    const normalized = normalizeBackendCostAggregates({
      generations: { rowCount: -3, recentCreditCost: 'not-a-number', byStatus: { failed: -1 } },
    });

    expect(normalized?.generations.rowCount).toBe(0);
    expect(normalized?.generations.recentCreditCost).toBe(0);
    expect(normalized?.generations.byStatus.failed).toBe(0);
    expect(normalized?.aiUsage.rowCount).toBe(0);
  });
});
