import type { SupabaseClient } from '@supabase/supabase-js';

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

export type BackendCostReport = {
  status: BackendCostReportStatus;
  checkedAt: string;
  window: {
    recentHours: number;
    since: string;
  };
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
    recentEvents: number;
    failedCount: number;
    slowCount: number;
    maxDurationMs: number;
    byService: Record<string, number>;
    failuresByService: Record<string, number>;
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

function buildProviderDependencies(rows: ProviderDependencyCostRow[]) {
  const byService: Record<string, number> = {};
  const failuresByService: Record<string, number> = {};
  let failedCount = 0;
  let slowCount = 0;
  let maxDurationMs = 0;

  for (const row of rows) {
    const serviceName = row.service_name ?? 'unknown';
    const outcome = row.outcome ?? 'unknown';
    const durationMs = Math.round(numericValue(row.duration_ms));
    incrementCount(byService, serviceName);
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    if (outcome !== 'success') {
      failedCount += 1;
      incrementCount(failuresByService, serviceName);
    }
    if (durationMs >= SLOW_PROVIDER_DURATION_MS) {
      slowCount += 1;
    }
  }

  return {
    recentEvents: rows.length,
    failedCount,
    slowCount,
    maxDurationMs,
    byService,
    failuresByService,
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

export async function collectBackendCostReport(
  client: SupabaseClient,
  now = new Date(),
  options: CollectBackendCostReportOptions = {},
): Promise<BackendCostReport> {
  const since = new Date(now.getTime() - RECENT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const budgetPolicy = buildBackendCostBudgetPolicy(options.budgetPolicy, options.environment);
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
      .limit(QUERY_LIMIT),
    client
      .from('ai_usage_events')
      .select('feature,status,cost,created_at')
      .gte('created_at', since)
      .limit(QUERY_LIMIT),
    client
      .from('provider_dependency_events')
      .select('service_name,outcome,duration_ms,created_at')
      .gte('created_at', since)
      .limit(QUERY_LIMIT),
    client
      .from('backend_rate_limits')
      .select('scope,request_count,window_start,updated_at')
      .gte('window_start', since)
      .limit(QUERY_LIMIT),
    client
      .schema('storage')
      .from('objects')
      .select('bucket_id,name,metadata,created_at')
      .in('bucket_id', GENERATED_STORAGE_BUCKETS)
      .gte('created_at', since)
      .limit(QUERY_LIMIT),
  ]);

  if (generationsResult.error) throw generationsResult.error;
  if (aiUsageResult.error) throw aiUsageResult.error;
  if (providerDependenciesResult.error) throw providerDependenciesResult.error;
  if (rateLimitsResult.error) throw rateLimitsResult.error;
  const storageGrowthUnavailable = Boolean(
    storageObjectsResult.error && isStorageSchemaUnavailableError(storageObjectsResult.error),
  );
  if (storageObjectsResult.error && !storageGrowthUnavailable) throw storageObjectsResult.error;

  const generationSpend = buildGenerationSpend((generationsResult.data ?? []) as GenerationCostRow[]);
  const aiUsageSpend = buildAiUsageSpend((aiUsageResult.data ?? []) as AiUsageCostRow[]);
  const providerDependencies = buildProviderDependencies(
    (providerDependenciesResult.data ?? []) as ProviderDependencyCostRow[],
  );
  const rateLimitPressure = buildRateLimitPressure((rateLimitsResult.data ?? []) as RateLimitCostRow[]);
  const storageGrowth = buildStorageGrowth(
    storageGrowthUnavailable ? [] : (storageObjectsResult.data ?? []) as StorageObjectCostRow[],
  );
  const issues = buildCostIssues({
    generationSpend,
    aiUsageSpend,
    providerDependencies,
    rateLimitPressure,
    storageGrowth,
    budgetPolicy,
  });
  if (storageGrowthUnavailable) {
    issues.push({
      severity: 'warning',
      code: 'STORAGE_GROWTH_UNAVAILABLE',
      message: 'Generated storage growth could not be measured because the Supabase storage schema is unavailable through the Data API.',
    });
  }

  return {
    status: maxStatus(['ok', ...issues.map((issue) => issue.severity)]),
    checkedAt: now.toISOString(),
    window: {
      recentHours: RECENT_WINDOW_HOURS,
      since,
    },
    budgetPolicy,
    generationSpend,
    aiUsageSpend,
    providerDependencies,
    rateLimitPressure,
    storageGrowth,
    issues,
  };
}
