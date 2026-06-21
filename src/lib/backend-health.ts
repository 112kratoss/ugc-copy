import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  buildGenerationModelCatalog,
} from '@/lib/generation-model-catalog';

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

export type BackendHealthIssue = {
  severity: Exclude<BackendHealthStatus, 'ok'>;
  code: string;
  message: string;
};

export type BackendJobHealth = {
  name: string;
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
  recentRuns: number;
  recentFailures: number;
  recentSkips: number;
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

export type BackendHealth = {
  status: BackendHealthStatus;
  checkedAt: string;
  buildId: string;
  catalog: {
    revision: string;
    schemaVersion: number;
    activeModels: number;
  };
  jobs: BackendJobHealth[];
  generations: BackendGenerationHealth;
  completionQueue: BackendCompletionQueueHealth;
  aiUsage: BackendAiUsageHealth;
  issues: BackendHealthIssue[];
};

const JOB_THRESHOLDS: Array<{ name: string; expectedMaxAgeMinutes: number }> = [
  { name: 'media-preview-repair', expectedMaxAgeMinutes: 120 },
  { name: 'mobile-push-receipts', expectedMaxAgeMinutes: 36 * 60 },
  { name: 'generation-completions', expectedMaxAgeMinutes: 30 },
];

const JOB_LOOKBACK_HOURS = 48;
const GENERATION_RECENT_WINDOW_MINUTES = 60;
const GENERATION_STALLED_AFTER_MINUTES = 60;
const GENERATION_PENDING_WITHOUT_PROVIDER_TASK_AFTER_MINUTES = 5;
const COMPLETION_QUEUE_STALE_PENDING_AFTER_MINUTES = 15;
const COMPLETION_QUEUE_STALE_PROCESSING_AFTER_MINUTES = 10;
const AI_USAGE_RECENT_WINDOW_MINUTES = 60;
const AI_USAGE_STALE_PENDING_AFTER_MINUTES = 15;

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
  job: { name: string; expectedMaxAgeMinutes: number },
  rows: BackendJobRunRow[],
  now: Date,
): { health: BackendJobHealth; issues: BackendHealthIssue[] } {
  const jobRows = rows.filter((row) => row.job_name === job.name);
  const latest = jobRows[0] ?? null;
  const lastSuccess = jobRows.find((row) => row.status === 'succeeded') ?? null;
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
  } else if (!lastSuccess) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'JOB_NO_RECENT_SUCCESS',
      message: `${job.name} has no successful run in the last ${JOB_LOOKBACK_HOURS} hours.`,
    });
  } else if (minutesSince(lastSuccess.started_at, now) > job.expectedMaxAgeMinutes) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'JOB_STALE_SUCCESS',
      message: `${job.name} has not succeeded within ${job.expectedMaxAgeMinutes} minutes.`,
    });
  }

  return {
    health: {
      name: job.name,
      status,
      expectedMaxAgeMinutes: job.expectedMaxAgeMinutes,
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
      recentRuns: jobRows.length,
      recentFailures,
      recentSkips,
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

export async function collectBackendHealth(
  client: SupabaseClient,
  now = new Date(),
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

  const [
    jobRunsResult,
    recentGenerationsResult,
    stalledGenerationsResult,
    pendingWithoutProviderTaskResult,
    completionQueueResult,
    recentAiUsageResult,
    stalePendingAiUsageResult,
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
  ]);

  if (jobRunsResult.error) throw jobRunsResult.error;
  if (recentGenerationsResult.error) throw recentGenerationsResult.error;
  if (stalledGenerationsResult.error) throw stalledGenerationsResult.error;
  if (pendingWithoutProviderTaskResult.error) throw pendingWithoutProviderTaskResult.error;
  if (completionQueueResult.error) throw completionQueueResult.error;
  if (recentAiUsageResult.error) throw recentAiUsageResult.error;
  if (stalePendingAiUsageResult.error) throw stalePendingAiUsageResult.error;

  const jobRows = (jobRunsResult.data ?? []) as BackendJobRunRow[];
  const jobResults = JOB_THRESHOLDS.map((job) => buildJobHealth(job, jobRows, now));
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
  const catalog = buildGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  });
  const issues = [
    ...jobResults.flatMap((result) => result.issues),
    ...generationResult.issues,
    ...completionQueueResultHealth.issues,
    ...aiUsageResult.issues,
  ];
  const componentStatuses = [
    ...jobResults.map((result) => result.health.status),
    generationResult.health.status,
    completionQueueResultHealth.health.status,
    aiUsageResult.health.status,
  ];

  return {
    status: maxStatus(componentStatuses),
    checkedAt: now.toISOString(),
    buildId: getBuildId(),
    catalog: {
      revision: catalog.revision,
      schemaVersion: catalog.schemaVersion,
      activeModels: catalog.models.length,
    },
    jobs: jobResults.map((result) => result.health),
    generations: generationResult.health,
    completionQueue: completionQueueResultHealth.health,
    aiUsage: aiUsageResult.health,
    issues,
  };
}
