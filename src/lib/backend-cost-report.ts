import type { SupabaseClient } from '@supabase/supabase-js';

import {
  collectGenerationCompletionSources,
  type GenerationCompletionSourceBreakdown,
} from '@/lib/generation-completion-source';

import {
  collectOperationalTableGrowth,
  type OperationalTableGrowthReport,
} from '@/lib/operational-table-growth';

import {
  fetchBackendCostAggregates,
  type BackendCostAggregates,
} from '@/lib/backend-cost-aggregates';

export type BackendCostReportStatus = 'ok' | 'warning' | 'degraded';

type GenerationCostRow = {
  status: string | null;
  model: string | null;
  cost: number | string | null;
  created_at: string | null;
  output_url: string | null;
};

type AiUsageCostRow = {
  feature: string | null;
  status: string | null;
  cost: number | string | null;
  created_at: string | null;
};

type ProviderDependencyCostRow = {
  service_name: string | null;
  outcome: string | null;
  duration_ms: number | string | null;
  created_at: string | null;
  model_id?: string | null;
};

type RateLimitCostRow = {
  scope: string | null;
  request_count: number | string | null;
  window_start: string | null;
  updated_at: string | null;
};

type StorageObjectCostRow = {
  bucket_id: string | null;
  name: string | null;
  metadata: unknown;
  created_at: string | null;
};

type SupabaseQueryError = {
  code?: unknown;
  message?: unknown;
};

export type BackendCostReportIssue = {
  severity: Exclude<BackendCostReportStatus, 'ok'>;
  code: string;
  message: string;
};

export type BackendCostBudgetPolicy = {
  generationCreditCostWarning: number;
  generationCreditCostDegraded: number;
  aiUsageCreditCostWarning: number;
  aiUsageCreditCostDegraded: number;
  failedPaidGenerationDegradedCredits: number;
  quoteRequestsWarning: number;
  quoteRequestsDegraded: number;
  mediaReadRequestsWarning: number;
  mediaReadRequestsDegraded: number;
  storageGrowthWarningBytes: number;
  storageGrowthDegradedBytes: number;
};

/**
 * Whether each source returned everything in the window or only the first
 * QUERY_LIMIT rows.
 *
 * Without this the report gets quietly *more* optimistic as traffic grows:
 * every figure below is computed from whatever the cap returned, so past the
 * cap a sample is presented as the population with no indication anywhere. A
 * truncated source means the numbers drawn from it are lower bounds.
 *
 * `mode` says which half of F15a produced the numbers. On `aggregate` the
 * database grouped the whole window and `truncated` is structurally false —
 * `rows` is then the exact population rather than a kept-row count, and `limit`
 * is reported as 0 because no cap applied. On `raw-rows` the collector fell
 * back to downloading rows and the cap is live again.
 */
export type BackendCostSampling = {
  mode: 'aggregate' | 'raw-rows';
  limit: number;
  truncated: boolean;
  sources: Array<{ source: string; rows: number; truncated: boolean }>;
};

export type BackendCostReport = {
  status: BackendCostReportStatus;
  checkedAt: string;
  window: {
    recentHours: number;
    since: string;
  };
  sampling: BackendCostSampling;
  budgetPolicy: BackendCostBudgetPolicy;
  generationSpend: {
    recentRuns: number;
    recentCreditCost: number;
    failedPaidCount: number;
    failedPaidCreditCost: number;
    completedOutputCount: number;
    byStatus: Record<string, number>;
    byModel: Record<string, number>;
  };
  aiUsageSpend: {
    recentEvents: number;
    recentCreditCost: number;
    failedCount: number;
    byFeature: Record<string, number>;
    byStatus: Record<string, number>;
  };
  providerDependencies: {
    /**
     * NOT total provider calls. `provider-fetch.ts` persists an event only when
     * a call failed or ran past the slow threshold, so this counts exceptions,
     * not attempts. `failedCount / recentEvents` is therefore not a failure
     * rate — it approaches 1 no matter how healthy the provider is.
     *
     * A real rate needs an attempt counter that does not write a row per call;
     * see F15a in `docs/scaling-audit-2026-08-08.md`. Until then this field is
     * a volume signal only, and `population` says so to anything consuming it.
     */
    recentEvents: number;
    /** What `recentEvents` actually counted, so a consumer cannot mistake it. */
    population: 'failures-and-slow-calls';
    /**
     * Total call attempts in the window, from the hourly counters every
     * provider fetch increments — the denominator the event table cannot
     * provide. `failedCount / recentAttempts` is a real failure rate. Null when
     * the counter table is unavailable (a database without the migration).
     * Bucketed hourly, so the window is floored to the hour and may include up
     * to one extra hour of attempts — a slight overcount, which for a failure
     * denominator errs conservative.
     */
    recentAttempts: number | null;
    attemptsByService: Record<string, number> | null;
    failedCount: number;
    slowCount: number;
    maxDurationMs: number;
    byService: Record<string, number>;
    failuresByService: Record<string, number>;
    timeoutsByService: Record<string, number>;
    /**
     * Per-model counts, restricted to model-attributed events. Calls with no
     * model (payments, FX, push) are absent rather than grouped under a
     * placeholder, so a model's denominator is only its own traffic.
     */
    byModel: Record<string, number>;
    failuresByModel: Record<string, number>;
    timeoutsByModel: Record<string, number>;
  };
  rateLimitPressure: {
    totalRequests: number;
    quoteRequests: number;
    mediaReadRequests: number;
    maxWindowRequestCount: number;
    byScope: Record<string, number>;
  };
  storageGrowth: {
    recentObjectCount: number;
    recentBytes: number;
    largestObjectBytes: number;
    bytesByBucket: Record<string, number>;
    objectsByBucket: Record<string, number>;
  };
  /**
   * Row counts and byte sizes for the churn-prone operational tables managed by
   * the retention sweep. Null when the reporting function is unavailable, for
   * example against a database that has not applied the migration yet.
   */
  operationalTableGrowth: OperationalTableGrowthReport | null;
  /**
   * Which runner is actually settling generation completions. This is the
   * evidence the durable-queue decision rests on — see
   * `generation-completion-source.ts`.
   */
  generationCompletionSources: GenerationCompletionSourceBreakdown;
  issues: BackendCostReportIssue[];
};

export type CollectBackendCostReportOptions = {
  budgetPolicy?: Partial<BackendCostBudgetPolicy>;
  environment?: NodeJS.ProcessEnv;
};

const RECENT_WINDOW_HOURS = 24;
const QUERY_LIMIT = 5000;
const SLOW_PROVIDER_DURATION_MS = 15_000;
const DEFAULT_BUDGET_POLICY: BackendCostBudgetPolicy = {
  generationCreditCostWarning: 20_000,
  generationCreditCostDegraded: 50_000,
  aiUsageCreditCostWarning: 1_000,
  aiUsageCreditCostDegraded: 5_000,
  failedPaidGenerationDegradedCredits: 100,
  quoteRequestsWarning: 1_000,
  quoteRequestsDegraded: 5_000,
  mediaReadRequestsWarning: 5_000,
  mediaReadRequestsDegraded: 20_000,
  storageGrowthWarningBytes: 1024 * 1024 * 1024,
  storageGrowthDegradedBytes: 5 * 1024 * 1024 * 1024,
};
const BUDGET_POLICY_ENV_KEYS: Record<keyof BackendCostBudgetPolicy, string> = {
  generationCreditCostWarning: 'BACKEND_BUDGET_GENERATION_CREDITS_WARNING',
  generationCreditCostDegraded: 'BACKEND_BUDGET_GENERATION_CREDITS_DEGRADED',
  aiUsageCreditCostWarning: 'BACKEND_BUDGET_AI_USAGE_CREDITS_WARNING',
  aiUsageCreditCostDegraded: 'BACKEND_BUDGET_AI_USAGE_CREDITS_DEGRADED',
  failedPaidGenerationDegradedCredits: 'BACKEND_BUDGET_FAILED_PAID_GENERATION_CREDITS_DEGRADED',
  quoteRequestsWarning: 'BACKEND_BUDGET_QUOTE_REQUESTS_WARNING',
  quoteRequestsDegraded: 'BACKEND_BUDGET_QUOTE_REQUESTS_DEGRADED',
  mediaReadRequestsWarning: 'BACKEND_BUDGET_MEDIA_READS_WARNING',
  mediaReadRequestsDegraded: 'BACKEND_BUDGET_MEDIA_READS_DEGRADED',
  storageGrowthWarningBytes: 'BACKEND_BUDGET_STORAGE_BYTES_WARNING',
  storageGrowthDegradedBytes: 'BACKEND_BUDGET_STORAGE_BYTES_DEGRADED',
};
const GENERATED_STORAGE_BUCKETS = [
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
];
const MEDIA_READ_RATE_LIMIT_SCOPES = new Set([
  'media-read:sign',
  'post-resource-file:read-url',
  'showcase-preview:read-url',
  'temporary-media-upload:read-url',
  'workflow-asset-upload:read-url',
]);

function numericValue(value: number | string | null | undefined): number {
  const valueAsNumber = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(valueAsNumber) || valueAsNumber < 0) {
    return 0;
  }

  return valueAsNumber;
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  const valueAsNumber = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(valueAsNumber) && valueAsNumber > 0 ? Math.round(valueAsNumber) : fallback;
}

export function buildBackendCostBudgetPolicy(
  overrides: Partial<BackendCostBudgetPolicy> = {},
  environment: NodeJS.ProcessEnv = process.env,
): BackendCostBudgetPolicy {
  const envPolicy = Object.fromEntries(
    (Object.keys(DEFAULT_BUDGET_POLICY) as Array<keyof BackendCostBudgetPolicy>).map((key) => [
      key,
      positiveNumberOrDefault(environment[BUDGET_POLICY_ENV_KEYS[key]], DEFAULT_BUDGET_POLICY[key]),
    ]),
  ) as BackendCostBudgetPolicy;

  const policy = {
    ...envPolicy,
    ...Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        positiveNumberOrDefault(value, envPolicy[key as keyof BackendCostBudgetPolicy]),
      ]),
    ),
  } as BackendCostBudgetPolicy;

  return {
    ...policy,
    generationCreditCostDegraded: Math.max(policy.generationCreditCostDegraded, policy.generationCreditCostWarning),
    aiUsageCreditCostDegraded: Math.max(policy.aiUsageCreditCostDegraded, policy.aiUsageCreditCostWarning),
    quoteRequestsDegraded: Math.max(policy.quoteRequestsDegraded, policy.quoteRequestsWarning),
    mediaReadRequestsDegraded: Math.max(policy.mediaReadRequestsDegraded, policy.mediaReadRequestsWarning),
    storageGrowthDegradedBytes: Math.max(policy.storageGrowthDegradedBytes, policy.storageGrowthWarningBytes),
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function incrementCost(counts: Record<string, number>, key: string, value: number) {
  counts[key] = rounded((counts[key] ?? 0) + value);
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function maxStatus(statuses: BackendCostReportStatus[]): BackendCostReportStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function isStorageSchemaUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message } = error as SupabaseQueryError;
  return code === 'PGRST106'
    && typeof message === 'string'
    && message.toLowerCase().includes('invalid schema')
    && message.toLowerCase().includes('storage');
}

function getStorageObjectSize(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 0;
  }

  return Math.round(numericValue((metadata as { size?: unknown }).size as number | string | null));
}

function buildGenerationSpend(rows: GenerationCostRow[]) {
  const byStatus: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let recentCreditCost = 0;
  let failedPaidCount = 0;
  let failedPaidCreditCost = 0;
  let completedOutputCount = 0;

  for (const row of rows) {
    const status = row.status ?? 'unknown';
    const model = row.model ?? 'unknown';
    const cost = numericValue(row.cost);
    recentCreditCost += cost;
    incrementCost(byStatus, status, cost);
    incrementCost(byModel, model, cost);

    if (status === 'failed' && cost > 0) {
      failedPaidCount += 1;
      failedPaidCreditCost += cost;
    }
    if ((status === 'succeeded' || status === 'completed') && row.output_url) {
      completedOutputCount += 1;
    }
  }

  return {
    recentRuns: rows.length,
    recentCreditCost: rounded(recentCreditCost),
    failedPaidCount,
    failedPaidCreditCost: rounded(failedPaidCreditCost),
    completedOutputCount,
    byStatus,
    byModel,
  };
}

function buildAiUsageSpend(rows: AiUsageCostRow[]) {
  const byFeature: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let recentCreditCost = 0;
  let failedCount = 0;

  for (const row of rows) {
    const feature = row.feature ?? 'unknown';
    const status = row.status ?? 'unknown';
    const cost = numericValue(row.cost);
    recentCreditCost += cost;
    incrementCost(byFeature, feature, cost);
    incrementCost(byStatus, status, cost);
    if (status === 'failed') {
      failedCount += 1;
    }
  }

  return {
    recentEvents: rows.length,
    recentCreditCost: rounded(recentCreditCost),
    failedCount,
    byFeature,
    byStatus,
  };
}


/**
 * Minimum events for a per-service rate to be meaningful. Below this, one
 * failure out of two calls would read as a 50% outage.
 */
export const PROVIDER_RATE_MIN_SAMPLE = 20;
/**
 * Per-model floor, deliberately lower than the per-service one. A service name
 * aggregates every model behind it, so per-model traffic is a fraction of
 * per-service traffic and reusing 20 would keep most models permanently below
 * the reporting floor — the exact blindness this dimension exists to remove.
 * 10 is the smallest sample at which one failure (1/10 = 10%) still sits below
 * the 20% warning band, so a single unlucky call can never raise an alert by
 * itself.
 */
export const PROVIDER_MODEL_RATE_MIN_SAMPLE = 10;
export const PROVIDER_ERROR_RATE_WARNING = 0.2;
export const PROVIDER_ERROR_RATE_DEGRADED = 0.5;
export const PROVIDER_TIMEOUT_RATE_WARNING = 0.1;
export const PROVIDER_TIMEOUT_RATE_DEGRADED = 0.3;

function buildRateIssuesForDimension({
  totals,
  failuresBy,
  timeoutsBy,
  minSample,
  describe,
  errorCodes,
  timeoutCodes,
}: {
  totals: Record<string, number>;
  failuresBy: Record<string, number>;
  timeoutsBy: Record<string, number>;
  minSample: number;
  describe: (key: string) => string;
  errorCodes: { degraded: string; warning: string };
  timeoutCodes: { degraded: string; warning: string };
}): BackendCostReportIssue[] {
  const issues: BackendCostReportIssue[] = [];

  for (const [key, total] of Object.entries(totals)) {
    if (total < minSample) continue;

    const failures = failuresBy[key] ?? 0;
    const timeouts = timeoutsBy[key] ?? 0;
    const errorRate = failures / total;
    const timeoutRate = timeouts / total;
    const subject = describe(key);

    if (errorRate >= PROVIDER_ERROR_RATE_DEGRADED) {
      issues.push({
        severity: 'degraded',
        code: errorCodes.degraded,
        message: `${subject} failed ${failures} of ${total} call(s) (${Math.round(errorRate * 100)}%) in the report window.`,
      });
    } else if (errorRate >= PROVIDER_ERROR_RATE_WARNING) {
      issues.push({
        severity: 'warning',
        code: errorCodes.warning,
        message: `${subject} failed ${failures} of ${total} call(s) (${Math.round(errorRate * 100)}%) in the report window.`,
      });
    }

    // Timeouts are reported separately from general failures: they point at
    // provider latency or a too-tight budget rather than a rejected request.
    if (timeoutRate >= PROVIDER_TIMEOUT_RATE_DEGRADED) {
      issues.push({
        severity: 'degraded',
        code: timeoutCodes.degraded,
        message: `${subject} timed out on ${timeouts} of ${total} call(s) (${Math.round(timeoutRate * 100)}%) in the report window.`,
      });
    } else if (timeoutRate >= PROVIDER_TIMEOUT_RATE_WARNING) {
      issues.push({
        severity: 'warning',
        code: timeoutCodes.warning,
        message: `${subject} timed out on ${timeouts} of ${total} call(s) (${Math.round(timeoutRate * 100)}%) in the report window.`,
      });
    }
  }

  return issues;
}

export function buildProviderRateIssues(
  providerDependencies: BackendCostReport['providerDependencies'],
): BackendCostReportIssue[] {
  return [
    ...buildRateIssuesForDimension({
      totals: providerDependencies.byService,
      failuresBy: providerDependencies.failuresByService,
      timeoutsBy: providerDependencies.timeoutsByService,
      minSample: PROVIDER_RATE_MIN_SAMPLE,
      describe: (serviceName) => serviceName,
      errorCodes: {
        degraded: 'PROVIDER_ERROR_RATE_DEGRADED',
        warning: 'PROVIDER_ERROR_RATE_ELEVATED',
      },
      timeoutCodes: {
        degraded: 'PROVIDER_TIMEOUT_RATE_DEGRADED',
        warning: 'PROVIDER_TIMEOUT_RATE_ELEVATED',
      },
    }),
    // Reported under distinct codes so a single failing model does not read as
    // a whole-provider outage in the alert stream.
    ...buildRateIssuesForDimension({
      totals: providerDependencies.byModel ?? {},
      failuresBy: providerDependencies.failuresByModel ?? {},
      timeoutsBy: providerDependencies.timeoutsByModel ?? {},
      minSample: PROVIDER_MODEL_RATE_MIN_SAMPLE,
      describe: (modelId) => `Model ${modelId}`,
      errorCodes: {
        degraded: 'PROVIDER_MODEL_ERROR_RATE_DEGRADED',
        warning: 'PROVIDER_MODEL_ERROR_RATE_ELEVATED',
      },
      timeoutCodes: {
        degraded: 'PROVIDER_MODEL_TIMEOUT_RATE_DEGRADED',
        warning: 'PROVIDER_MODEL_TIMEOUT_RATE_ELEVATED',
      },
    }),
  ];
}

function buildProviderDependencies(rows: ProviderDependencyCostRow[]) {
  const byService: Record<string, number> = {};
  const failuresByService: Record<string, number> = {};
  const timeoutsByService: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const failuresByModel: Record<string, number> = {};
  const timeoutsByModel: Record<string, number> = {};
  let failedCount = 0;
  let slowCount = 0;
  let maxDurationMs = 0;

  for (const row of rows) {
    const serviceName = row.service_name ?? 'unknown';
    const outcome = row.outcome ?? 'unknown';
    const durationMs = Math.round(numericValue(row.duration_ms));
    // Unattributed rows are skipped entirely for per-model counts rather than
    // bucketed as 'unknown': a synthetic bucket would accumulate every
    // payment, FX, and push call and then trip model alert thresholds.
    const modelId = typeof row.model_id === 'string' && row.model_id.trim()
      ? row.model_id.trim()
      : null;
    incrementCount(byService, serviceName);
    if (modelId) incrementCount(byModel, modelId);
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    if (outcome !== 'success') {
      failedCount += 1;
      incrementCount(failuresByService, serviceName);
      if (modelId) incrementCount(failuresByModel, modelId);
    }
    if (outcome === 'timeout') {
      incrementCount(timeoutsByService, serviceName);
      if (modelId) incrementCount(timeoutsByModel, modelId);
    }
    if (durationMs >= SLOW_PROVIDER_DURATION_MS) {
      slowCount += 1;
    }
  }

  return {
    recentEvents: rows.length,
    // Stated rather than implied: these rows are the exceptions, so nothing
    // downstream should divide by them and call the result a failure rate.
    population: 'failures-and-slow-calls' as const,
    failedCount,
    slowCount,
    maxDurationMs,
    byService,
    failuresByService,
    timeoutsByService,
    byModel,
    failuresByModel,
    timeoutsByModel,
  };
}

function buildRateLimitPressure(rows: RateLimitCostRow[]) {
  const byScope: Record<string, number> = {};
  let totalRequests = 0;
  let quoteRequests = 0;
  let mediaReadRequests = 0;
  let maxWindowRequestCount = 0;

  for (const row of rows) {
    const scope = row.scope ?? 'unknown';
    const requestCount = Math.round(numericValue(row.request_count));
    totalRequests += requestCount;
    maxWindowRequestCount = Math.max(maxWindowRequestCount, requestCount);
    byScope[scope] = (byScope[scope] ?? 0) + requestCount;
    if (scope === 'generation-model:quote') {
      quoteRequests += requestCount;
    }
    if (MEDIA_READ_RATE_LIMIT_SCOPES.has(scope)) {
      mediaReadRequests += requestCount;
    }
  }

  return {
    totalRequests,
    quoteRequests,
    mediaReadRequests,
    maxWindowRequestCount,
    byScope,
  };
}

function buildStorageGrowth(rows: StorageObjectCostRow[]) {
  const bytesByBucket: Record<string, number> = {};
  const objectsByBucket: Record<string, number> = {};
  let recentBytes = 0;
  let largestObjectBytes = 0;

  for (const row of rows) {
    const bucket = row.bucket_id ?? 'unknown';
    const sizeBytes = getStorageObjectSize(row.metadata);
    recentBytes += sizeBytes;
    largestObjectBytes = Math.max(largestObjectBytes, sizeBytes);
    bytesByBucket[bucket] = (bytesByBucket[bucket] ?? 0) + sizeBytes;
    objectsByBucket[bucket] = (objectsByBucket[bucket] ?? 0) + 1;
  }

  return {
    recentObjectCount: rows.length,
    recentBytes,
    largestObjectBytes,
    bytesByBucket,
    objectsByBucket,
  };
}

/*
 * ─── F15a: the same five summaries, from database-side aggregates ────────────
 *
 * These sit next to their raw-row twins on purpose. Each one is the *only*
 * thing the aggregate path adds on top of `get_backend_cost_aggregates`, and
 * reading it against the builder directly above shows what moved into SQL and
 * what did not. Nothing here re-derives arithmetic; where a value looks
 * computed it is policy that must not live in the database.
 */

function buildGenerationSpendFromAggregates(
  aggregates: BackendCostAggregates,
): BackendCostReport['generationSpend'] {
  const { generations } = aggregates;
  return {
    recentRuns: generations.rowCount,
    recentCreditCost: rounded(generations.recentCreditCost),
    failedPaidCount: generations.failedPaidCount,
    failedPaidCreditCost: rounded(generations.failedPaidCreditCost),
    completedOutputCount: generations.completedOutputCount,
    byStatus: generations.byStatus,
    byModel: generations.byModel,
  };
}

function buildAiUsageSpendFromAggregates(
  aggregates: BackendCostAggregates,
): BackendCostReport['aiUsageSpend'] {
  const { aiUsage } = aggregates;
  return {
    recentEvents: aiUsage.rowCount,
    recentCreditCost: rounded(aiUsage.recentCreditCost),
    failedCount: aiUsage.failedCount,
    byFeature: aiUsage.byFeature,
    byStatus: aiUsage.byStatus,
  };
}

function buildProviderDependenciesFromAggregates(aggregates: BackendCostAggregates) {
  const { providerDependencies } = aggregates;
  return {
    recentEvents: providerDependencies.rowCount,
    // Unchanged by the aggregate move, and worth restating: the underlying
    // table still only holds failures and slow calls, so this is a volume
    // signal. Computing it in SQL does not make it a denominator.
    population: 'failures-and-slow-calls' as const,
    failedCount: providerDependencies.failedCount,
    slowCount: providerDependencies.slowCount,
    maxDurationMs: providerDependencies.maxDurationMs,
    byService: providerDependencies.byService,
    failuresByService: providerDependencies.failuresByService,
    timeoutsByService: providerDependencies.timeoutsByService,
    byModel: providerDependencies.byModel,
    failuresByModel: providerDependencies.failuresByModel,
    timeoutsByModel: providerDependencies.timeoutsByModel,
  };
}

/**
 * The quote and media-read splits are derived here rather than in SQL. Which
 * scopes count as a media read is a product decision that changes whenever a
 * route is added — `MEDIA_READ_RATE_LIMIT_SCOPES` is the single place that
 * knows, and pushing it into a migration would fork it into two places that
 * drift silently.
 */
function buildRateLimitPressureFromAggregates(
  aggregates: BackendCostAggregates,
): BackendCostReport['rateLimitPressure'] {
  const { rateLimits } = aggregates;
  let quoteRequests = 0;
  let mediaReadRequests = 0;

  for (const [scope, requestCount] of Object.entries(rateLimits.byScope)) {
    if (scope === 'generation-model:quote') {
      quoteRequests += requestCount;
    }
    if (MEDIA_READ_RATE_LIMIT_SCOPES.has(scope)) {
      mediaReadRequests += requestCount;
    }
  }

  return {
    totalRequests: rateLimits.totalRequests,
    quoteRequests,
    mediaReadRequests,
    maxWindowRequestCount: rateLimits.maxWindowRequestCount,
    byScope: rateLimits.byScope,
  };
}

function buildStorageGrowthFromAggregates(
  aggregates: BackendCostAggregates,
): BackendCostReport['storageGrowth'] {
  const { storage } = aggregates;
  return {
    recentObjectCount: storage.rowCount,
    recentBytes: storage.recentBytes,
    largestObjectBytes: storage.largestObjectBytes,
    bytesByBucket: storage.bytesByBucket,
    objectsByBucket: storage.objectsByBucket,
  };
}

function buildCostIssues({
  generationSpend,
  aiUsageSpend,
  providerDependencies,
  rateLimitPressure,
  storageGrowth,
  budgetPolicy,
}: Pick<BackendCostReport, 'generationSpend' | 'aiUsageSpend' | 'providerDependencies' | 'rateLimitPressure' | 'storageGrowth' | 'budgetPolicy'>): BackendCostReportIssue[] {
  const issues: BackendCostReportIssue[] = [];

  if (generationSpend.recentCreditCost >= budgetPolicy.generationCreditCostDegraded) {
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_SPEND_SPIKE',
      message: `${generationSpend.recentCreditCost} generation credit(s) were spent in the report window.`,
    });
  } else if (generationSpend.recentCreditCost >= budgetPolicy.generationCreditCostWarning) {
    issues.push({
      severity: 'warning',
      code: 'GENERATION_SPEND_ELEVATED',
      message: `${generationSpend.recentCreditCost} generation credit(s) were spent in the report window.`,
    });
  }

  if (generationSpend.failedPaidCreditCost >= budgetPolicy.failedPaidGenerationDegradedCredits) {
    issues.push({
      severity: 'degraded',
      code: 'FAILED_PAID_GENERATION_SPIKE',
      message: `${generationSpend.failedPaidCreditCost} credits are tied to failed paid generations in the report window.`,
    });
  } else if (generationSpend.failedPaidCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'FAILED_PAID_GENERATIONS',
      message: `${generationSpend.failedPaidCount} paid generation(s) failed in the report window.`,
    });
  }

  if (aiUsageSpend.failedCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'AI_USAGE_FAILURES',
      message: `${aiUsageSpend.failedCount} non-generation AI usage event(s) failed in the report window.`,
    });
  }

  if (providerDependencies.failedCount > 0) {
    issues.push({
      severity: providerDependencies.failedCount >= 5 ? 'degraded' : 'warning',
      code: providerDependencies.failedCount >= 5 ? 'PROVIDER_DEPENDENCY_FAILURE_SPIKE' : 'PROVIDER_DEPENDENCY_FAILURES',
      message: `${providerDependencies.failedCount} provider dependency failure(s) were recorded in the report window.`,
    });
  }

  // Per-service rates, not just the absolute count above: a provider degrading
  // in isolation is invisible in a total, and a rate only means something once
  // there is enough traffic to divide by.
  issues.push(...buildProviderRateIssues(providerDependencies));

  if (aiUsageSpend.recentCreditCost >= budgetPolicy.aiUsageCreditCostDegraded) {
    issues.push({
      severity: 'degraded',
      code: 'AI_USAGE_SPEND_SPIKE',
      message: `${aiUsageSpend.recentCreditCost} non-generation AI usage credit(s) were spent in the report window.`,
    });
  } else if (aiUsageSpend.recentCreditCost >= budgetPolicy.aiUsageCreditCostWarning) {
    issues.push({
      severity: 'warning',
      code: 'AI_USAGE_SPEND_ELEVATED',
      message: `${aiUsageSpend.recentCreditCost} non-generation AI usage credit(s) were spent in the report window.`,
    });
  }

  if (rateLimitPressure.quoteRequests >= budgetPolicy.quoteRequestsDegraded) {
    issues.push({
      severity: 'degraded',
      code: 'QUOTE_PRESSURE_SPIKE',
      message: `${rateLimitPressure.quoteRequests} generation quote request(s) were counted in the report window.`,
    });
  } else if (rateLimitPressure.quoteRequests >= budgetPolicy.quoteRequestsWarning) {
    issues.push({
      severity: 'warning',
      code: 'QUOTE_PRESSURE_ELEVATED',
      message: `${rateLimitPressure.quoteRequests} generation quote request(s) were counted in the report window.`,
    });
  }

  if (rateLimitPressure.mediaReadRequests >= budgetPolicy.mediaReadRequestsDegraded) {
    issues.push({
      severity: 'degraded',
      code: 'MEDIA_READ_PRESSURE_SPIKE',
      message: `${rateLimitPressure.mediaReadRequests} media read/sign request(s) were counted in the report window.`,
    });
  } else if (rateLimitPressure.mediaReadRequests >= budgetPolicy.mediaReadRequestsWarning) {
    issues.push({
      severity: 'warning',
      code: 'MEDIA_READ_PRESSURE_ELEVATED',
      message: `${rateLimitPressure.mediaReadRequests} media read/sign request(s) were counted in the report window.`,
    });
  }

  if (storageGrowth.recentBytes >= budgetPolicy.storageGrowthDegradedBytes) {
    issues.push({
      severity: 'degraded',
      code: 'STORAGE_GROWTH_SPIKE',
      message: `${storageGrowth.recentBytes} generated media byte(s) were created in the report window.`,
    });
  } else if (storageGrowth.recentBytes >= budgetPolicy.storageGrowthWarningBytes) {
    issues.push({
      severity: 'warning',
      code: 'STORAGE_GROWTH_ELEVATED',
      message: `${storageGrowth.recentBytes} generated media byte(s) were created in the report window.`,
    });
  }

  return issues;
}

/**
 * The five window summaries plus how they were obtained. Both paths produce
 * this identically — that equivalence is what
 * `src/__tests__/backend-cost-aggregates.test.ts` asserts.
 */
type BackendCostSummaries = {
  generationSpend: BackendCostReport['generationSpend'];
  aiUsageSpend: BackendCostReport['aiUsageSpend'];
  providerDependencies: Omit<
    BackendCostReport['providerDependencies'],
    'recentAttempts' | 'attemptsByService'
  >;
  rateLimitPressure: BackendCostReport['rateLimitPressure'];
  storageGrowth: BackendCostReport['storageGrowth'];
  sampling: BackendCostSampling;
  storageGrowthUnavailable: boolean;
};

/**
 * F15a's aggregate path: one RPC, the whole window, no cap.
 *
 * `sources` still carries a row count per source, but here it is the exact
 * population rather than however many rows fitted under the cap, and
 * `truncated` is false because nothing was sampled. Storage is read inside the
 * SECURITY DEFINER function, so the PostgREST `storage` schema exposure that
 * the raw path has to tolerate is not involved at all.
 */
function summarizeFromAggregates(aggregates: BackendCostAggregates): BackendCostSummaries {
  return {
    generationSpend: buildGenerationSpendFromAggregates(aggregates),
    aiUsageSpend: buildAiUsageSpendFromAggregates(aggregates),
    providerDependencies: buildProviderDependenciesFromAggregates(aggregates),
    rateLimitPressure: buildRateLimitPressureFromAggregates(aggregates),
    storageGrowth: buildStorageGrowthFromAggregates(aggregates),
    sampling: {
      mode: 'aggregate',
      limit: 0,
      truncated: false,
      sources: [
        { source: 'generations', rows: aggregates.generations.rowCount, truncated: false },
        { source: 'ai_usage_events', rows: aggregates.aiUsage.rowCount, truncated: false },
        { source: 'provider_dependency_events', rows: aggregates.providerDependencies.rowCount, truncated: false },
        { source: 'backend_rate_limits', rows: aggregates.rateLimits.rowCount, truncated: false },
        { source: 'storage.objects', rows: aggregates.storage.rowCount, truncated: false },
      ],
    },
    storageGrowthUnavailable: false,
  };
}

/**
 * The pre-F15a path, kept live as the fallback for a database without
 * `get_backend_cost_aggregates`. Keeping it is what stops this change from
 * trading a tested JS implementation for an untested SQL one — see the header
 * of `backend-cost-aggregates.ts`.
 */
async function summarizeFromRawRows(
  client: SupabaseClient,
  since: string,
): Promise<BackendCostSummaries> {
  const [
    generationsResult,
    aiUsageResult,
    providerDependenciesResult,
    rateLimitsResult,
    storageObjectsResult,
  ] = await Promise.all([
    client
      .from('generations')
      .select('status,model,cost,created_at,output_url')
      .gte('created_at', since)
      .limit(QUERY_LIMIT + 1),
    client
      .from('ai_usage_events')
      .select('feature,status,cost,created_at')
      .gte('created_at', since)
      .limit(QUERY_LIMIT + 1),
    client
      .from('provider_dependency_events')
      .select('service_name,outcome,duration_ms,created_at,model_id')
      .gte('created_at', since)
      .limit(QUERY_LIMIT + 1),
    client
      .from('backend_rate_limits')
      .select('scope,request_count,window_start,updated_at')
      .gte('window_start', since)
      .limit(QUERY_LIMIT + 1),
    client
      .schema('storage')
      .from('objects')
      .select('bucket_id,name,metadata,created_at')
      .in('bucket_id', GENERATED_STORAGE_BUCKETS)
      .gte('created_at', since)
      .limit(QUERY_LIMIT + 1),
  ]);

  if (generationsResult.error) throw generationsResult.error;
  if (aiUsageResult.error) throw aiUsageResult.error;
  if (providerDependenciesResult.error) throw providerDependenciesResult.error;
  if (rateLimitsResult.error) throw rateLimitsResult.error;
  const storageGrowthUnavailable = Boolean(
    storageObjectsResult.error && isStorageSchemaUnavailableError(storageObjectsResult.error),
  );
  if (storageObjectsResult.error && !storageGrowthUnavailable) throw storageObjectsResult.error;

  // Each query asked for one row past the cap, so an overflow is visible
  // without paying for a COUNT over the window -- which is exactly the sort of
  // query that gets expensive at the traffic where this matters.
  const samplingSources: BackendCostSampling['sources'] = [];
  function sample<TRow>(source: string, rows: TRow[]): TRow[] {
    const truncated = rows.length > QUERY_LIMIT;
    const kept = truncated ? rows.slice(0, QUERY_LIMIT) : rows;
    samplingSources.push({ source, rows: kept.length, truncated });
    return kept;
  }

  const generationSpend = buildGenerationSpend(
    sample('generations', (generationsResult.data ?? []) as GenerationCostRow[]),
  );
  const aiUsageSpend = buildAiUsageSpend(
    sample('ai_usage_events', (aiUsageResult.data ?? []) as AiUsageCostRow[]),
  );
  const providerDependencies = buildProviderDependencies(
    sample('provider_dependency_events', (providerDependenciesResult.data ?? []) as ProviderDependencyCostRow[]),
  );
  const rateLimitPressure = buildRateLimitPressure(
    sample('backend_rate_limits', (rateLimitsResult.data ?? []) as RateLimitCostRow[]),
  );
  const storageGrowth = buildStorageGrowth(
    sample(
      'storage.objects',
      storageGrowthUnavailable ? [] : (storageObjectsResult.data ?? []) as StorageObjectCostRow[],
    ),
  );
  return {
    generationSpend,
    aiUsageSpend,
    providerDependencies,
    rateLimitPressure,
    storageGrowth,
    sampling: {
      mode: 'raw-rows',
      limit: QUERY_LIMIT,
      truncated: samplingSources.some((source) => source.truncated),
      sources: samplingSources,
    },
    storageGrowthUnavailable,
  };
}

export async function collectBackendCostReport(
  client: SupabaseClient,
  now = new Date(),
  options: CollectBackendCostReportOptions = {},
): Promise<BackendCostReport> {
  const since = new Date(now.getTime() - RECENT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const budgetPolicy = buildBackendCostBudgetPolicy(options.budgetPolicy, options.environment);

  // Aggregates first, raw rows only if the function is unavailable. The
  // fallback is a real code path, not dead code: it runs against any database
  // that has not applied 20260809200000.
  const aggregates = await fetchBackendCostAggregates(
    client,
    since,
    GENERATED_STORAGE_BUCKETS,
    SLOW_PROVIDER_DURATION_MS,
  );
  const {
    generationSpend,
    aiUsageSpend,
    providerDependencies,
    rateLimitPressure,
    storageGrowth,
    sampling,
    storageGrowthUnavailable,
  } = aggregates
    ? summarizeFromAggregates(aggregates)
    : await summarizeFromRawRows(client, since);

  // Attempt counters are the failure-rate denominator; fail soft because a
  // database without the migration must still produce a report. The whole
  // block is inside the try: a client can throw synchronously on an unknown
  // table.
  let providerAttempts: { total: number; byService: Record<string, number> } | null = null;
  try {
    const sinceHourFloor = new Date(
      Math.floor((now.getTime() - RECENT_WINDOW_HOURS * 60 * 60 * 1000) / (60 * 60 * 1000)) * 60 * 60 * 1000,
    ).toISOString();
    const attemptsResult = await client
      .from('provider_fetch_attempt_counters')
      .select('service_name,attempt_count')
      .gte('bucket_start', sinceHourFloor);
    if (!attemptsResult.error) {
      const byService: Record<string, number> = {};
      let total = 0;
      for (const row of (attemptsResult.data ?? []) as Array<{ service_name: string | null; attempt_count: number | string | null }>) {
        const count = numericValue(row.attempt_count);
        const service = row.service_name ?? 'unknown';
        byService[service] = (byService[service] ?? 0) + count;
        total += count;
      }
      providerAttempts = { total, byService };
    }
  } catch {
    // Counter table unavailable; the report says null rather than guessing.
  }
  const providerDependenciesWithAttempts = {
    ...providerDependencies,
    recentAttempts: providerAttempts?.total ?? null,
    attemptsByService: providerAttempts?.byService ?? null,
  };
  const issues = buildCostIssues({
    generationSpend,
    aiUsageSpend,
    providerDependencies: providerDependenciesWithAttempts,
    rateLimitPressure,
    storageGrowth,
    budgetPolicy,
  });
  // Note there is deliberately no issue raised for `mode === 'raw-rows'`. The
  // fallback is exact whenever it does not truncate, so alerting on it would
  // fire on every collection against a database that simply has not applied the
  // migration yet — local stacks included. `sampling.mode` carries the state as
  // data; truncation below is the thing that is actually wrong. State on the
  // payload, alarms only for lost accuracy.
  if (sampling.truncated) {
    // Deliberately an issue rather than a footnote: every figure drawn from a
    // truncated source is a lower bound, and the failure mode this prevents is
    // the report looking healthier precisely as load grows.
    const truncatedSources = sampling.sources
      .filter((source) => source.truncated)
      .map((source) => source.source)
      .join(', ');
    issues.push({
      severity: 'warning',
      code: 'COST_REPORT_TRUNCATED',
      message: `Cost report read only the first ${QUERY_LIMIT} rows from: ${truncatedSources}. Every figure derived from them is a lower bound.`,
    });
  }
  if (storageGrowthUnavailable) {
    issues.push({
      severity: 'warning',
      code: 'STORAGE_GROWTH_UNAVAILABLE',
      message: 'Generated storage growth could not be measured because the Supabase storage schema is unavailable through the Data API.',
    });
  }

  // Fail soft: a database without the growth function still produces a report,
  // it simply cannot show operational table growth.
  let operationalTableGrowth: OperationalTableGrowthReport | null = null;
  try {
    operationalTableGrowth = await collectOperationalTableGrowth(client);
    for (const issue of operationalTableGrowth.issues) {
      issues.push({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
      });
    }
  } catch {
    issues.push({
      severity: 'warning',
      code: 'OPERATIONAL_TABLE_GROWTH_UNAVAILABLE',
      message: 'Operational table growth could not be measured because get_operational_table_growth is unavailable.',
    });
  }

  const generationCompletionSources = await collectGenerationCompletionSources(client, now);

  return {
    status: maxStatus(['ok', ...issues.map((issue) => issue.severity)]),
    checkedAt: now.toISOString(),
    window: {
      recentHours: RECENT_WINDOW_HOURS,
      since,
    },
    sampling,
    budgetPolicy,
    generationSpend,
    aiUsageSpend,
    providerDependencies: providerDependenciesWithAttempts,
    rateLimitPressure,
    storageGrowth,
    operationalTableGrowth,
    generationCompletionSources,
    issues,
  };
}
