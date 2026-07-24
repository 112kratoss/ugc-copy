import type { SupabaseClient } from '@supabase/supabase-js';

import {
  collectBackendEnvironmentHealth,
  type BackendEnvironmentHealth,
} from '@/lib/backend-environment';
import {
  BACKEND_JOB_DAILY_INVOCATION_BUDGET,
  BACKEND_JOB_REGISTRY,
  BACKEND_JOB_SCHEDULER,
  type BackendJobDefinition,
} from '@/lib/backend-jobs';
import {
  GENERATION_MODEL_CATALOG_V1_SCHEMA_VERSION,
} from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';

export type BackendHealthStatus = 'ok' | 'warning' | 'degraded';

type BackendJobRunRow = {
  job_name: string;
  status: 'started' | 'succeeded' | 'skipped' | 'failed';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  skip_reason: string | null;
  error_message: string | null;
};

type GenerationStatusRow = {
  status: string | null;
  created_at: string | null;
  cost: number | string | null;
};

type StalledGenerationRow = {
  created_at: string | null;
  cost: number | string | null;
};

type PendingGenerationWithoutProviderTaskRow = {
  created_at: string | null;
  cost: number | string | null;
};

type GenerationCompletionQueueRow = {
  status: string | null;
  created_at: string | null;
  next_attempt_at: string | null;
  locked_at: string | null;
};

type AiUsageEventRow = {
  feature: string | null;
  status: string | null;
  medium: string | null;
  cost: number | string | null;
  created_at: string | null;
};

type ProviderDependencyEventRow = {
  service_name: string | null;
  outcome: 'success' | 'http_error' | 'timeout' | 'network_error' | string | null;
  duration_ms: number | string | null;
  timeout_ms: number | string | null;
  status: number | string | null;
  created_at: string | null;
};

export type BackendHealthIssue = {
  severity: Exclude<BackendHealthStatus, 'ok'>;
  code: string;
  message: string;
};

export type BackendJobHealth = {
  name: string;
  route: string;
  schedule: string;
  cadenceMinutes: number;
  dailyInvocations: number;
  maxMissedRunsBeforeDegraded: number;
  status: BackendHealthStatus;
  expectedMaxAgeMinutes: number;
  latestRun: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    skipReason: string | null;
    hasError: boolean;
  } | null;
  lastSuccessAt: string | null;
  lastHealthyAt: string | null;
  recentRuns: number;
  recentFailures: number;
  recentSkips: number;
};

export type BackendSchedulerHealth = {
  status: BackendHealthStatus;
  route: string;
  schedule: string;
  cadenceMinutes: number;
  maxDurationSeconds: number;
  dailyInvocations: number;
  dailyInvocationBudget: number;
  logicalDailyInvocations: number;
  coveredJobCount: number;
  coveredJobs: Array<{
    name: string;
    route: string;
    schedule: string;
    cadenceMinutes: number;
    dailyInvocations: number;
  }>;
};

export type BackendGenerationHealth = {
  status: BackendHealthStatus;
  recentWindowMinutes: number;
  stalledAfterMinutes: number;
  pendingWithoutProviderTaskAfterMinutes: number;
  recentCounts: Record<string, number>;
  recentCreditCostTotal: number;
  recentCreditCostByStatus: Record<string, number>;
  stalledActiveCount: number;
  stalledActiveCreditCost: number;
  oldestStalledCreatedAt: string | null;
  pendingWithoutProviderTaskCount: number;
  pendingWithoutProviderTaskCreditCost: number;
  oldestPendingWithoutProviderTaskCreatedAt: string | null;
};

export type BackendCompletionQueueHealth = {
  status: BackendHealthStatus;
  stalePendingAfterMinutes: number;
  staleProcessingAfterMinutes: number;
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  staleDuePendingCount: number;
  staleProcessingCount: number;
  oldestDuePendingNextAttemptAt: string | null;
  oldestProcessingLockedAt: string | null;
  oldestFailedCreatedAt: string | null;
};

export type BackendAiUsageHealth = {
  status: BackendHealthStatus;
  recentWindowMinutes: number;
  stalePendingAfterMinutes: number;
  recentCounts: Record<string, number>;
  recentCreditCostTotal: number;
  recentCreditCostByStatus: Record<string, number>;
  recentCreditCostByFeature: Record<string, number>;
  pendingCount: number;
  failedCount: number;
  refundedCount: number;
  refundedCreditCost: number;
  stalePendingCount: number;
  stalePendingCreditCost: number;
  oldestStalePendingCreatedAt: string | null;
};

export type BackendProviderDependencyHealth = {
  status: BackendHealthStatus;
  recentWindowMinutes: number;
  slowAfterMs: number;
  recentEventCount: number;
  failedEventCount: number;
  timeoutCount: number;
  networkErrorCount: number;
  slowCount: number;
  averageDurationMs: number;
  maxDurationMs: number;
  countsByOutcome: Record<string, number>;
  countsByService: Record<string, number>;
  failedByService: Record<string, number>;
  slowByService: Record<string, number>;
  oldestRecentEventAt: string | null;
};

export type BackendHealth = {
  status: BackendHealthStatus;
  checkedAt: string;
  buildId: string;
  environment: BackendEnvironmentHealth | null;
  catalog: {
    revision: string;
    schemaVersion: number;
    activeModels: number;
    source: 'code' | 'shadow' | 'database';
    releaseId: string | null;
  };
  scheduler: BackendSchedulerHealth;
  jobs: BackendJobHealth[];
  generations: BackendGenerationHealth;
  completionQueue: BackendCompletionQueueHealth;
  aiUsage: BackendAiUsageHealth;
  providerDependencies: BackendProviderDependencyHealth;
  issues: BackendHealthIssue[];
};

const JOB_LOOKBACK_HOURS = 48;
const GENERATION_RECENT_WINDOW_MINUTES = 60;
const GENERATION_STALLED_AFTER_MINUTES = 60;
const GENERATION_PENDING_WITHOUT_PROVIDER_TASK_AFTER_MINUTES = 5;
const COMPLETION_QUEUE_STALE_PENDING_AFTER_MINUTES = 15;
const COMPLETION_QUEUE_STALE_PROCESSING_AFTER_MINUTES = 10;
const AI_USAGE_RECENT_WINDOW_MINUTES = 60;
const AI_USAGE_STALE_PENDING_AFTER_MINUTES = 15;
const PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES = 60;
const PROVIDER_DEPENDENCY_SLOW_AFTER_MS = 15_000;
const PROVIDER_DEPENDENCY_FAILURE_DEGRADED_COUNT = 5;
const PROVIDER_DEPENDENCY_TIMEOUT_DEGRADED_COUNT = 3;
const PROVIDER_DEPENDENCY_SLOW_DEGRADED_COUNT = 5;
const JOB_RECENT_FAILURE_WARNING_COUNT = 3;

function minutesSince(timestamp: string, now: Date): number {
  const ms = now.getTime() - new Date(timestamp).getTime();
  return Math.max(0, Math.floor(ms / 60000));
}

function getBuildId(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.VERCEL_DEPLOYMENT_ID?.trim()
    || process.env.VERCEL_URL?.trim()
    || 'dev'
  );
}

function maxStatus(statuses: BackendHealthStatus[]): BackendHealthStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function buildJobHealth(
  job: BackendJobDefinition,
  rows: BackendJobRunRow[],
  now: Date,
): { health: BackendJobHealth; issues: BackendHealthIssue[] } {
  const jobRows = rows.filter((row) => row.job_name === job.name);
  const latest = jobRows[0] ?? null;
  const lastSuccess = jobRows.find((row) => row.status === 'succeeded') ?? null;
  const expectedNoWorkSkipReason = job.noWorkSkipReason;
  const lastHealthyRun = jobRows.find((row) => (
    row.status === 'succeeded'
    || (row.status === 'skipped' && row.skip_reason === expectedNoWorkSkipReason)
  )) ?? null;
  const recentFailures = jobRows.filter((row) => row.status === 'failed').length;
  const recentSkips = jobRows.filter((row) => row.status === 'skipped').length;
  const issues: BackendHealthIssue[] = [];

  let status: BackendHealthStatus = 'ok';
  if (!latest) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'JOB_NO_RECENT_RUN',
      message: `${job.name} has no recorded run in the last ${JOB_LOOKBACK_HOURS} hours.`,
    });
  } else if (latest.status === 'failed') {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'JOB_LATEST_RUN_FAILED',
      message: `${job.name} latest run failed.`,
    });
  } else if (!lastHealthyRun) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'JOB_NO_RECENT_SUCCESS',
      message: `${job.name} has no successful or healthy no-work run in the last ${JOB_LOOKBACK_HOURS} hours.`,
    });
  } else if (minutesSince(lastHealthyRun.started_at, now) > job.healthExpectedMaxAgeMinutes) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'JOB_STALE_SUCCESS',
      message: `${job.name} has not succeeded or reported healthy no-work within ${job.healthExpectedMaxAgeMinutes} minutes.`,
    });
  }
  if (status === 'ok' && recentFailures >= JOB_RECENT_FAILURE_WARNING_COUNT) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'JOB_RECENT_FAILURES',
      message: `${job.name} had ${recentFailures} failed run(s) in the last ${JOB_LOOKBACK_HOURS} hours.`,
    });
  }

  return {
    health: {
      name: job.name,
      route: job.route,
      schedule: job.schedule,
      cadenceMinutes: job.cadenceMinutes,
      dailyInvocations: job.dailyInvocations,
      maxMissedRunsBeforeDegraded: job.maxMissedRunsBeforeDegraded,
      status,
      expectedMaxAgeMinutes: job.healthExpectedMaxAgeMinutes,
      latestRun: latest
        ? {
            status: latest.status,
            startedAt: latest.started_at,
            finishedAt: latest.finished_at,
            durationMs: latest.duration_ms,
            skipReason: latest.skip_reason,
            hasError: Boolean(latest.error_message),
          }
        : null,
      lastSuccessAt: lastSuccess?.started_at ?? null,
      lastHealthyAt: lastHealthyRun?.started_at ?? null,
      recentRuns: jobRows.length,
      recentFailures,
      recentSkips,
    },
    issues,
  };
}

function buildSchedulerHealth(): { health: BackendSchedulerHealth; issues: BackendHealthIssue[] } {
  const logicalDailyInvocations = BACKEND_JOB_REGISTRY.reduce(
    (total, job) => total + job.dailyInvocations,
    0,
  );
  const issues: BackendHealthIssue[] = [];
  let status: BackendHealthStatus = 'ok';

  if (BACKEND_JOB_SCHEDULER.dailyInvocations > BACKEND_JOB_DAILY_INVOCATION_BUDGET) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'SCHEDULER_DAILY_INVOCATION_BUDGET_EXCEEDED',
      message: `Backend scheduler uses ${BACKEND_JOB_SCHEDULER.dailyInvocations} Vercel cron invocation(s) per day, above the ${BACKEND_JOB_DAILY_INVOCATION_BUDGET} budget.`,
    });
  }

  const uncoveredJobs = BACKEND_JOB_REGISTRY.filter((job) => (
    job.cadenceMinutes % BACKEND_JOB_SCHEDULER.cadenceMinutes !== 0
  ));
  if (uncoveredJobs.length > 0) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'SCHEDULER_UNCOVERED_JOB_CADENCE',
      message: `Backend scheduler cadence cannot cover: ${uncoveredJobs.map((job) => job.name).join(', ')}.`,
    });
  }

  return {
    health: {
      status,
      route: BACKEND_JOB_SCHEDULER.route,
      schedule: BACKEND_JOB_SCHEDULER.schedule,
      cadenceMinutes: BACKEND_JOB_SCHEDULER.cadenceMinutes,
      maxDurationSeconds: BACKEND_JOB_SCHEDULER.maxDurationSeconds,
      dailyInvocations: BACKEND_JOB_SCHEDULER.dailyInvocations,
      dailyInvocationBudget: BACKEND_JOB_DAILY_INVOCATION_BUDGET,
      logicalDailyInvocations,
      coveredJobCount: BACKEND_JOB_REGISTRY.length,
      coveredJobs: BACKEND_JOB_REGISTRY.map((job) => ({
        name: job.name,
        route: job.route,
        schedule: job.schedule,
        cadenceMinutes: job.cadenceMinutes,
        dailyInvocations: job.dailyInvocations,
      })),
    },
    issues,
  };
}

function buildGenerationHealth(
  recentRows: GenerationStatusRow[],
  stalledRows: StalledGenerationRow[],
  pendingWithoutProviderTaskRows: PendingGenerationWithoutProviderTaskRow[],
): { health: BackendGenerationHealth; issues: BackendHealthIssue[] } {
  const recentCounts = recentRows.reduce<Record<string, number>>((counts, row) => {
    const status = row.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const recentCreditCostByStatus = recentRows.reduce<Record<string, number>>((costs, row) => {
    const status = row.status ?? 'unknown';
    costs[status] = roundCredits((costs[status] ?? 0) + getCreditCost(row.cost));
    return costs;
  }, {});
  const recentCreditCostTotal = roundCredits(
    recentRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const stalledActiveCreditCost = roundCredits(
    stalledRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const pendingWithoutProviderTaskCreditCost = roundCredits(
    pendingWithoutProviderTaskRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const issues: BackendHealthIssue[] = [];
  const stalledActiveCount = stalledRows.length;
  const pendingWithoutProviderTaskCount = pendingWithoutProviderTaskRows.length;

  let status: BackendHealthStatus = 'ok';
  if (stalledActiveCount > 0) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_STALLED_ACTIVE',
      message: `${stalledActiveCount} active generation(s) are older than ${GENERATION_STALLED_AFTER_MINUTES} minutes.`,
    });
  }
  if (pendingWithoutProviderTaskCount > 0) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_PENDING_WITHOUT_PROVIDER_TASK',
      message: `${pendingWithoutProviderTaskCount} pending generation(s) have no provider task id after ${GENERATION_PENDING_WITHOUT_PROVIDER_TASK_AFTER_MINUTES} minutes.`,
    });
  }

  return {
    health: {
      status,
      recentWindowMinutes: GENERATION_RECENT_WINDOW_MINUTES,
      stalledAfterMinutes: GENERATION_STALLED_AFTER_MINUTES,
      pendingWithoutProviderTaskAfterMinutes: GENERATION_PENDING_WITHOUT_PROVIDER_TASK_AFTER_MINUTES,
      recentCounts,
      recentCreditCostTotal,
      recentCreditCostByStatus,
      stalledActiveCount,
      stalledActiveCreditCost,
      oldestStalledCreatedAt: stalledRows[0]?.created_at ?? null,
      pendingWithoutProviderTaskCount,
      pendingWithoutProviderTaskCreditCost,
      oldestPendingWithoutProviderTaskCreatedAt: pendingWithoutProviderTaskRows[0]?.created_at ?? null,
    },
    issues,
  };
}

function getCreditCost(value: number | string | null | undefined): number {
  const numericValue = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return numericValue;
}

function roundCredits(value: number): number {
  return Number(value.toFixed(2));
}

function getPositiveInteger(value: number | string | null | undefined): number {
  const numericValue = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.round(numericValue);
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isDue(row: GenerationCompletionQueueRow, now: Date): boolean {
  if (!row.next_attempt_at) return false;
  return new Date(row.next_attempt_at).getTime() <= now.getTime();
}

function sortByTimestamp<T>(
  rows: T[],
  getTimestamp: (row: T) => string | null,
): T[] {
  return [...rows].sort((a, b) => {
    const left = getTimestamp(a);
    const right = getTimestamp(b);
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return new Date(left).getTime() - new Date(right).getTime();
  });
}

function buildCompletionQueueHealth(
  rows: GenerationCompletionQueueRow[],
  now: Date,
): { health: BackendCompletionQueueHealth; issues: BackendHealthIssue[] } {
  const pendingRows = rows.filter((row) => row.status === 'pending');
  const processingRows = rows.filter((row) => row.status === 'processing');
  const failedRows = rows.filter((row) => row.status === 'failed');
  const duePendingRows = pendingRows.filter((row) => isDue(row, now));
  const staleDuePendingRows = duePendingRows.filter((row) => (
    row.next_attempt_at
    && minutesSince(row.next_attempt_at, now) > COMPLETION_QUEUE_STALE_PENDING_AFTER_MINUTES
  ));
  const staleProcessingRows = processingRows.filter((row) => (
    row.locked_at
    && minutesSince(row.locked_at, now) > COMPLETION_QUEUE_STALE_PROCESSING_AFTER_MINUTES
  ));
  const oldestDuePending = sortByTimestamp(duePendingRows, (row) => row.next_attempt_at)[0] ?? null;
  const oldestProcessing = sortByTimestamp(processingRows, (row) => row.locked_at)[0] ?? null;
  const oldestFailed = sortByTimestamp(failedRows, (row) => row.created_at)[0] ?? null;
  const issues: BackendHealthIssue[] = [];

  if (failedRows.length > 0) {
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_COMPLETION_QUEUE_FAILED',
      message: `${failedRows.length} generation completion job(s) reached failed status.`,
    });
  }

  if (staleDuePendingRows.length > 0) {
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_COMPLETION_QUEUE_STALE_PENDING',
      message: `${staleDuePendingRows.length} due generation completion job(s) are older than ${COMPLETION_QUEUE_STALE_PENDING_AFTER_MINUTES} minutes.`,
    });
  }

  if (staleProcessingRows.length > 0) {
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_COMPLETION_QUEUE_STALE_LOCK',
      message: `${staleProcessingRows.length} generation completion job lock(s) are older than ${COMPLETION_QUEUE_STALE_PROCESSING_AFTER_MINUTES} minutes.`,
    });
  }

  return {
    health: {
      status: issues.length > 0 ? 'degraded' : 'ok',
      stalePendingAfterMinutes: COMPLETION_QUEUE_STALE_PENDING_AFTER_MINUTES,
      staleProcessingAfterMinutes: COMPLETION_QUEUE_STALE_PROCESSING_AFTER_MINUTES,
      pendingCount: pendingRows.length,
      processingCount: processingRows.length,
      failedCount: failedRows.length,
      staleDuePendingCount: staleDuePendingRows.length,
      staleProcessingCount: staleProcessingRows.length,
      oldestDuePendingNextAttemptAt: oldestDuePending?.next_attempt_at ?? null,
      oldestProcessingLockedAt: oldestProcessing?.locked_at ?? null,
      oldestFailedCreatedAt: oldestFailed?.created_at ?? null,
    },
    issues,
  };
}

function buildAiUsageHealth(
  recentRows: AiUsageEventRow[],
  stalePendingRows: AiUsageEventRow[],
): { health: BackendAiUsageHealth; issues: BackendHealthIssue[] } {
  const recentCounts = recentRows.reduce<Record<string, number>>((counts, row) => {
    const status = row.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const recentCreditCostByStatus = recentRows.reduce<Record<string, number>>((costs, row) => {
    const status = row.status ?? 'unknown';
    costs[status] = roundCredits((costs[status] ?? 0) + getCreditCost(row.cost));
    return costs;
  }, {});
  const recentCreditCostByFeature = recentRows.reduce<Record<string, number>>((costs, row) => {
    const feature = row.feature ?? 'unknown';
    costs[feature] = roundCredits((costs[feature] ?? 0) + getCreditCost(row.cost));
    return costs;
  }, {});
  const recentCreditCostTotal = roundCredits(
    recentRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const refundedRows = recentRows.filter((row) => row.status === 'refunded');
  const refundedCreditCost = roundCredits(
    refundedRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const stalePendingCreditCost = roundCredits(
    stalePendingRows.reduce((total, row) => total + getCreditCost(row.cost), 0),
  );
  const pendingCount = recentRows.filter((row) => row.status === 'pending').length;
  const failedCount = recentRows.filter((row) => row.status === 'failed').length;
  const stalePendingCount = stalePendingRows.length;
  const issues: BackendHealthIssue[] = [];

  if (failedCount > 0) {
    issues.push({
      severity: 'degraded',
      code: 'AI_USAGE_FAILED',
      message: `${failedCount} non-generation AI usage event(s) failed in the last ${AI_USAGE_RECENT_WINDOW_MINUTES} minutes.`,
    });
  }

  if (stalePendingCount > 0) {
    issues.push({
      severity: 'degraded',
      code: 'AI_USAGE_STALE_PENDING',
      message: `${stalePendingCount} non-generation AI usage charge(s) are still pending after ${AI_USAGE_STALE_PENDING_AFTER_MINUTES} minutes.`,
    });
  }

  return {
    health: {
      status: issues.length > 0 ? 'degraded' : 'ok',
      recentWindowMinutes: AI_USAGE_RECENT_WINDOW_MINUTES,
      stalePendingAfterMinutes: AI_USAGE_STALE_PENDING_AFTER_MINUTES,
      recentCounts,
      recentCreditCostTotal,
      recentCreditCostByStatus,
      recentCreditCostByFeature,
      pendingCount,
      failedCount,
      refundedCount: refundedRows.length,
      refundedCreditCost,
      stalePendingCount,
      stalePendingCreditCost,
      oldestStalePendingCreatedAt: stalePendingRows[0]?.created_at ?? null,
    },
    issues,
  };
}

function buildProviderDependencyHealth(
  rows: ProviderDependencyEventRow[],
): { health: BackendProviderDependencyHealth; issues: BackendHealthIssue[] } {
  const countsByOutcome: Record<string, number> = {};
  const countsByService: Record<string, number> = {};
  const failedByService: Record<string, number> = {};
  const slowByService: Record<string, number> = {};
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let failedEventCount = 0;
  let timeoutCount = 0;
  let networkErrorCount = 0;
  let slowCount = 0;

  for (const row of rows) {
    const outcome = row.outcome ?? 'unknown';
    const serviceName = row.service_name ?? 'unknown';
    const durationMs = getPositiveInteger(row.duration_ms);
    totalDurationMs += durationMs;
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    incrementCount(countsByOutcome, outcome);
    incrementCount(countsByService, serviceName);

    if (outcome !== 'success') {
      failedEventCount += 1;
      incrementCount(failedByService, serviceName);
    }
    if (outcome === 'timeout') {
      timeoutCount += 1;
    }
    if (outcome === 'network_error') {
      networkErrorCount += 1;
    }
    if (durationMs >= PROVIDER_DEPENDENCY_SLOW_AFTER_MS) {
      slowCount += 1;
      incrementCount(slowByService, serviceName);
    }
  }

  const issues: BackendHealthIssue[] = [];
  let status: BackendHealthStatus = 'ok';

  if (
    failedEventCount >= PROVIDER_DEPENDENCY_FAILURE_DEGRADED_COUNT
    || timeoutCount >= PROVIDER_DEPENDENCY_TIMEOUT_DEGRADED_COUNT
  ) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'PROVIDER_DEPENDENCY_FAILURE_SPIKE',
      message: `${failedEventCount} provider dependency failure(s) were recorded in the last ${PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES} minutes.`,
    });
  } else if (failedEventCount > 0) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'PROVIDER_DEPENDENCY_FAILURES',
      message: `${failedEventCount} provider dependency failure(s) were recorded in the last ${PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES} minutes.`,
    });
  }

  if (slowCount >= PROVIDER_DEPENDENCY_SLOW_DEGRADED_COUNT) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'PROVIDER_DEPENDENCY_SLOW_SPIKE',
      message: `${slowCount} slow provider dependency call(s) exceeded ${PROVIDER_DEPENDENCY_SLOW_AFTER_MS}ms in the last ${PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES} minutes.`,
    });
  } else if (slowCount > 0) {
    status = maxStatus([status, 'warning']);
    issues.push({
      severity: 'warning',
      code: 'PROVIDER_DEPENDENCY_SLOW_CALLS',
      message: `${slowCount} slow provider dependency call(s) exceeded ${PROVIDER_DEPENDENCY_SLOW_AFTER_MS}ms in the last ${PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES} minutes.`,
    });
  }

  const oldestRecentEvent = sortByTimestamp(rows, (row) => row.created_at)[0] ?? null;

  return {
    health: {
      status,
      recentWindowMinutes: PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES,
      slowAfterMs: PROVIDER_DEPENDENCY_SLOW_AFTER_MS,
      recentEventCount: rows.length,
      failedEventCount,
      timeoutCount,
      networkErrorCount,
      slowCount,
      averageDurationMs: rows.length > 0 ? Math.round(totalDurationMs / rows.length) : 0,
      maxDurationMs,
      countsByOutcome,
      countsByService,
      failedByService,
      slowByService,
      oldestRecentEventAt: oldestRecentEvent?.created_at ?? null,
    },
    issues,
  };
}

export async function collectBackendHealth(
  client: SupabaseClient,
  now = new Date(),
  environmentVariables?: NodeJS.ProcessEnv,
): Promise<BackendHealth> {
  const jobSince = new Date(now.getTime() - JOB_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const recentGenerationSince = new Date(
    now.getTime() - GENERATION_RECENT_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();
  const stalledBefore = new Date(
    now.getTime() - GENERATION_STALLED_AFTER_MINUTES * 60 * 1000,
  ).toISOString();
  const pendingWithoutProviderTaskBefore = new Date(
    now.getTime() - GENERATION_PENDING_WITHOUT_PROVIDER_TASK_AFTER_MINUTES * 60 * 1000,
  ).toISOString();
  const recentAiUsageSince = new Date(
    now.getTime() - AI_USAGE_RECENT_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();
  const staleAiUsagePendingBefore = new Date(
    now.getTime() - AI_USAGE_STALE_PENDING_AFTER_MINUTES * 60 * 1000,
  ).toISOString();
  const recentProviderDependencySince = new Date(
    now.getTime() - PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();

  const [
    jobRunsResult,
    recentGenerationsResult,
    stalledGenerationsResult,
    pendingWithoutProviderTaskResult,
    completionQueueResult,
    recentAiUsageResult,
    stalePendingAiUsageResult,
    recentProviderDependencyResult,
  ] = await Promise.all([
    client
      .from('backend_job_runs')
      .select('job_name,status,started_at,finished_at,duration_ms,skip_reason,error_message')
      .gte('started_at', jobSince)
      .order('started_at', { ascending: false })
      .limit(200),
    client
      .from('generations')
      .select('status,created_at,cost')
      .gte('created_at', recentGenerationSince)
      .limit(1000),
    client
      .from('generations')
      .select('created_at,cost')
      .in('status', ['pending', 'waiting', 'processing'])
      .lt('created_at', stalledBefore)
      .order('created_at', { ascending: true })
      .limit(50),
    client
      .from('generations')
      .select('created_at,cost')
      .eq('status', 'pending')
      .is('prediction_id', null)
      .lt('created_at', pendingWithoutProviderTaskBefore)
      .order('created_at', { ascending: true })
      .limit(50),
    client
      .from('generation_completion_jobs')
      .select('status,created_at,next_attempt_at,locked_at')
      .in('status', ['pending', 'processing', 'failed'])
      .order('created_at', { ascending: true })
      .limit(200),
    client
      .from('ai_usage_events')
      .select('feature,status,medium,cost,created_at')
      .gte('created_at', recentAiUsageSince)
      .limit(1000),
    client
      .from('ai_usage_events')
      .select('feature,status,medium,cost,created_at')
      .eq('status', 'pending')
      .lt('created_at', staleAiUsagePendingBefore)
      .order('created_at', { ascending: true })
      .limit(50),
    client
      .from('provider_dependency_events')
      .select('service_name,outcome,duration_ms,timeout_ms,status,created_at')
      .gte('created_at', recentProviderDependencySince)
      .order('created_at', { ascending: true })
      .limit(1000),
  ]);

  if (jobRunsResult.error) throw jobRunsResult.error;
  if (recentGenerationsResult.error) throw recentGenerationsResult.error;
  if (stalledGenerationsResult.error) throw stalledGenerationsResult.error;
  if (pendingWithoutProviderTaskResult.error) throw pendingWithoutProviderTaskResult.error;
  if (completionQueueResult.error) throw completionQueueResult.error;
  if (recentAiUsageResult.error) throw recentAiUsageResult.error;
  if (stalePendingAiUsageResult.error) throw stalePendingAiUsageResult.error;
  if (recentProviderDependencyResult.error) throw recentProviderDependencyResult.error;

  const jobRows = (jobRunsResult.data ?? []) as BackendJobRunRow[];
  const jobResults = BACKEND_JOB_REGISTRY.map((job) => buildJobHealth(job, jobRows, now));
  const schedulerResult = buildSchedulerHealth();
  const generationResult = buildGenerationHealth(
    (recentGenerationsResult.data ?? []) as GenerationStatusRow[],
    (stalledGenerationsResult.data ?? []) as StalledGenerationRow[],
    (pendingWithoutProviderTaskResult.data ?? []) as PendingGenerationWithoutProviderTaskRow[],
  );
  const completionQueueResultHealth = buildCompletionQueueHealth(
    (completionQueueResult.data ?? []) as GenerationCompletionQueueRow[],
    now,
  );
  const aiUsageResult = buildAiUsageHealth(
    (recentAiUsageResult.data ?? []) as AiUsageEventRow[],
    (stalePendingAiUsageResult.data ?? []) as AiUsageEventRow[],
  );
  const providerDependencyResult = buildProviderDependencyHealth(
    (recentProviderDependencyResult.data ?? []) as ProviderDependencyEventRow[],
  );
  const environment = environmentVariables
    ? collectBackendEnvironmentHealth(environmentVariables)
    : null;
  const environmentIssues: BackendHealthIssue[] = environment?.status === 'degraded'
    ? [{
        severity: 'degraded',
        code: 'ENVIRONMENT_MISSING_REQUIRED',
        message: `Missing required backend environment capabilities: ${environment.missing.join(', ')}.`,
      }]
    : [];
  // Health uses the universally supported v1 projection during the transition.
  // The response still reports the release's actual schema version.
  const {
    catalog,
    source: catalogSource,
    releaseId: catalogReleaseId,
    releaseSchemaVersion: catalogReleaseSchemaVersion,
  } = await loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_V1_SCHEMA_VERSION,
  });
  const issues = [
    ...schedulerResult.issues,
    ...jobResults.flatMap((result) => result.issues),
    ...generationResult.issues,
    ...completionQueueResultHealth.issues,
    ...aiUsageResult.issues,
    ...providerDependencyResult.issues,
    ...environmentIssues,
  ];
  const componentStatuses = [
    schedulerResult.health.status,
    ...jobResults.map((result) => result.health.status),
    generationResult.health.status,
    completionQueueResultHealth.health.status,
    aiUsageResult.health.status,
    providerDependencyResult.health.status,
    ...(environment ? [environment.status] : []),
  ];

  return {
    status: maxStatus(componentStatuses),
    checkedAt: now.toISOString(),
    buildId: getBuildId(),
    environment,
    catalog: {
      revision: catalog.revision,
      schemaVersion: catalogReleaseSchemaVersion ?? catalog.schemaVersion,
      activeModels: catalog.models.length,
      source: catalogSource,
      releaseId: catalogReleaseId,
    },
    scheduler: schedulerResult.health,
    jobs: jobResults.map((result) => result.health),
    generations: generationResult.health,
    completionQueue: completionQueueResultHealth.health,
    aiUsage: aiUsageResult.health,
    providerDependencies: providerDependencyResult.health,
    issues,
  };
}
