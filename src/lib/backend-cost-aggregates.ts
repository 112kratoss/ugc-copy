/**
 * F15a: the database-side half of the backend cost report.
 *
 * `backend-cost-report.ts` historically downloaded up to 5 x 5,001 raw rows per
 * collection and grouped them in JS. The cap is honest — truncation is flagged
 * — but every figure drawn from a capped source is a lower bound, and the
 * report gets quietly more optimistic exactly as traffic grows.
 * `get_backend_cost_aggregates` does the grouping in the database, so the
 * window is read in full at any volume.
 *
 * THE RAW-ROW PATH IS NOT DELETED, and that is deliberate. It stays as the
 * fallback for a database without the migration, which means:
 *
 *   1. the JS arithmetic keeps running and keeps its unit tests, rather than
 *      becoming untested SQL — the specific risk the audit flagged for this
 *      item ("done carelessly the change *reduces* coverage of the logic while
 *      fixing a truncation that is not occurring"); and
 *   2. `backend-cost-aggregates.test.ts` can feed the same fixture through both
 *      paths and assert they agree, so the SQL is validated against the JS it
 *      replaces instead of simply replacing it.
 *
 * This module owns transport and shape only. Every threshold and every scope
 * classification stays in `backend-cost-report.ts`, because those are product
 * policy; this file must never grow a budget constant.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Per-key breakdown, e.g. credit cost by model or request count by scope. */
export type AggregateBreakdown = Record<string, number>;

export type BackendCostAggregates = {
  generations: {
    rowCount: number;
    recentCreditCost: number;
    failedPaidCount: number;
    failedPaidCreditCost: number;
    completedOutputCount: number;
    byStatus: AggregateBreakdown;
    byModel: AggregateBreakdown;
  };
  aiUsage: {
    rowCount: number;
    recentCreditCost: number;
    failedCount: number;
    byFeature: AggregateBreakdown;
    byStatus: AggregateBreakdown;
  };
  providerDependencies: {
    rowCount: number;
    failedCount: number;
    slowCount: number;
    maxDurationMs: number;
    byService: AggregateBreakdown;
    failuresByService: AggregateBreakdown;
    timeoutsByService: AggregateBreakdown;
    byModel: AggregateBreakdown;
    failuresByModel: AggregateBreakdown;
    timeoutsByModel: AggregateBreakdown;
  };
  rateLimits: {
    rowCount: number;
    totalRequests: number;
    maxWindowRequestCount: number;
    byScope: AggregateBreakdown;
  };
  storage: {
    rowCount: number;
    recentBytes: number;
    largestObjectBytes: number;
    bytesByBucket: AggregateBreakdown;
    objectsByBucket: AggregateBreakdown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mirrors `numericValue()` in `backend-cost-report.ts`: anything non-finite or
 * negative reads as 0. Kept as its own copy rather than imported so the two
 * modules do not develop an import cycle; the differential test pins that they
 * stay in step.
 */
function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function toBreakdown(value: unknown): AggregateBreakdown {
  if (!isRecord(value)) return {};

  const breakdown: AggregateBreakdown = {};
  for (const [key, entry] of Object.entries(value)) {
    breakdown[key] = toNumber(entry);
  }
  return breakdown;
}

/**
 * Shapes the RPC payload. Returns null when the payload is not an object at
 * all, so the caller can fall back rather than reporting a report full of
 * zeroes — a zeroed report is indistinguishable from a genuinely quiet window,
 * which is the same class of silent optimism F15a exists to remove.
 */
export function normalizeBackendCostAggregates(payload: unknown): BackendCostAggregates | null {
  if (!isRecord(payload)) return null;

  const generations = isRecord(payload.generations) ? payload.generations : {};
  const aiUsage = isRecord(payload.aiUsage) ? payload.aiUsage : {};
  const provider = isRecord(payload.providerDependencies) ? payload.providerDependencies : {};
  const rateLimits = isRecord(payload.rateLimits) ? payload.rateLimits : {};
  const storage = isRecord(payload.storage) ? payload.storage : {};

  return {
    generations: {
      rowCount: toNumber(generations.rowCount),
      recentCreditCost: toNumber(generations.recentCreditCost),
      failedPaidCount: toNumber(generations.failedPaidCount),
      failedPaidCreditCost: toNumber(generations.failedPaidCreditCost),
      completedOutputCount: toNumber(generations.completedOutputCount),
      byStatus: toBreakdown(generations.byStatus),
      byModel: toBreakdown(generations.byModel),
    },
    aiUsage: {
      rowCount: toNumber(aiUsage.rowCount),
      recentCreditCost: toNumber(aiUsage.recentCreditCost),
      failedCount: toNumber(aiUsage.failedCount),
      byFeature: toBreakdown(aiUsage.byFeature),
      byStatus: toBreakdown(aiUsage.byStatus),
    },
    providerDependencies: {
      rowCount: toNumber(provider.rowCount),
      failedCount: toNumber(provider.failedCount),
      slowCount: toNumber(provider.slowCount),
      maxDurationMs: toNumber(provider.maxDurationMs),
      byService: toBreakdown(provider.byService),
      failuresByService: toBreakdown(provider.failuresByService),
      timeoutsByService: toBreakdown(provider.timeoutsByService),
      byModel: toBreakdown(provider.byModel),
      failuresByModel: toBreakdown(provider.failuresByModel),
      timeoutsByModel: toBreakdown(provider.timeoutsByModel),
    },
    rateLimits: {
      rowCount: toNumber(rateLimits.rowCount),
      totalRequests: toNumber(rateLimits.totalRequests),
      maxWindowRequestCount: toNumber(rateLimits.maxWindowRequestCount),
      byScope: toBreakdown(rateLimits.byScope),
    },
    storage: {
      rowCount: toNumber(storage.rowCount),
      recentBytes: toNumber(storage.recentBytes),
      largestObjectBytes: toNumber(storage.largestObjectBytes),
      bytesByBucket: toBreakdown(storage.bytesByBucket),
      objectsByBucket: toBreakdown(storage.objectsByBucket),
    },
  };
}

/**
 * Fail-soft by design: a database that has not applied the migration still
 * produces a report, it simply produces it from raw rows. The whole call is
 * wrapped because a client can throw synchronously on an unknown function.
 */
export async function fetchBackendCostAggregates(
  client: SupabaseClient,
  since: string,
  storageBuckets: string[],
  slowDurationMs: number,
): Promise<BackendCostAggregates | null> {
  try {
    const { data, error } = await client.rpc('get_backend_cost_aggregates', {
      p_since: since,
      p_storage_buckets: storageBuckets,
      p_slow_duration_ms: slowDurationMs,
    });
    if (error) return null;
    return normalizeBackendCostAggregates(data);
  } catch {
    return null;
  }
}
