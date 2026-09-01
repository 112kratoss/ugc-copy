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
import {
  collectBackendQueueAgeHealth,
  type BackendQueueAgeHealth,
  type QueueClient,
} from '@/lib/backend-queue-age';
import {
  collectFeedRetentionLag,
  type FeedRetentionLagReport,
} from '@/lib/feed-retention-lag';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';
import { PAYMENT_WEBHOOK_PROCESSING_SERVICE_NAMES } from '@/lib/provider-dependency-telemetry';

export type BackendHealthStatus = 'ok' | 'warning' | 'degraded';

type BackendJobRunRow = {
  id: string;
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

type MediaRenditionRow = {
  rendition_status: string | null;
  rendition_attempt_count: number | null;
  created_at: string | null;
};

type MediaPreviewRow = {
  preview_status: string | null;
  preview_attempt_count: number | null;
  created_at: string | null;
};

type AiUsageEventRow = {
  feature: string | null;
  status: string | null;
  medium: string | null;
  cost: number | string | null;
  created_at: string | null;
};

type RemixablePostRow = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
};

type OrphanedShellPostRow = {
  id: string;
  visibility: string | null;
  created_at: string | null;
};

type RemixSourceProjectionRow = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
};

type ProviderDependencyEventRow = {
  service_name: string | null;
  model_id?: string | null;
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

/**
 * Derivative media that has not resolved yet. The repair sweep skips rows that
 * exhausted their attempts, so an all-exhausted backlog reports "no work" and
 * the job looks healthy forever — this counts the rows instead of the runs.
 */
export type BackendMediaPipelineHealth = {
  status: BackendHealthStatus;
  staleAfterMinutes: number;
  renditionPendingCount: number;
  renditionFailedCount: number;
  renditionExhaustedCount: number;
  previewPendingCount: number;
  previewFailedCount: number;
  previewExhaustedCount: number;
  oldestUnresolvedRenditionAt: string | null;
  oldestUnresolvedPreviewAt: string | null;
  sampleTruncated: boolean;
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
  /**
   * Per-model breakdown, covering only model-attributed events. Calls with no
   * model behind them (payments, FX, push receipts) are omitted rather than
   * grouped under a placeholder key.
   */
  countsByModel: Record<string, number>;
  failedByModel: Record<string, number>;
  /**
   * Payment webhook processing failures durably recorded under the dedicated
   * 'razorpay-webhook-processing' / 'revenuecat-webhook-processing' service
   * identifiers. Any occurrence in the window degrades health: each event is a
   * paid transaction whose settlement did not complete.
   */
  paymentWebhookProcessingFailureCount: number;
  oldestRecentEventAt: string | null;
};

/**
 * Proves the privileged read behind remix still resolves.
 *
 * The 2026-07-26 grant hardening narrowed the `authenticated` SELECT on
 * `generations` to a resume projection, and every reader that still went
 * through a user-scoped client started returning nothing — remix, publishing,
 * and workflow-run hydration each broke silently and were only found once
 * users reported dead buttons. Column privileges are evaluated before row
 * policies, so this class of break is invisible to any check that only counts
 * rows in a table the service role can still read.
 *
 * This check therefore performs the real read: it takes live public,
 * generation-backed posts and resolves each one's source through the same
 * projection and the same gate the remix service applies. If that stops
 * resolving, the release fails before promotion instead of after.
 */
export type BackendDataAccessHealth = {
  status: BackendHealthStatus;
  /** Public, visible, generation-backed posts examined this run. */
  remixSourcesSampled: number;
  /** Sources that were readable and satisfied the remix gate. */
  remixSourcesResolved: number;
  /** Readable but gate-failing sources — data drift, not a broken contract. */
  remixSourcesGateBlocked: number;
  /** Set when the projection itself could not be read (the grant regression). */
  projectionReadError: string | null;
};

/**
 * Media posts that never got their media rows.
 *
 * Publishing creates the post private, writes `post_media`, then promotes. When
 * the media write fails the compensating `posts.delete()` runs — and when that
 * delete also fails it is only warned about, leaving a private shell nothing
 * will ever clean up. Each one is invisible cruft rather than broken content,
 * so this counts them instead of paging anyone.
 */
export type BackendPostIntegrityHealth = {
  status: BackendHealthStatus;
  staleAfterMinutes: number;
  shellPostCount: number;
  oldestShellPostCreatedAt: string | null;
  sampleTruncated: boolean;
  /** Set when the probe itself could not be read. */
  probeReadError: string | null;
};

export type BackendMediaUploadReclaimPolicyHealth = {
  /** Whether Production supplied the one accepted opt-in value, `true`. */
  abandonedReclaimConfigured: boolean;
  /** The code-controlled compatibility floor that protects older drafts. */
  minimumAppVersion: string;
  /** Whether abandoned draft objects may actually be deleted. */
  abandonedReclaimEffective: boolean;
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
  queueAge: BackendQueueAgeHealth;
  feedRetentionLag: FeedRetentionLagReport;
  mediaPipeline: BackendMediaPipelineHealth;
  aiUsage: BackendAiUsageHealth;
  providerDependencies: BackendProviderDependencyHealth;
  dataAccess: BackendDataAccessHealth;
  postIntegrity: BackendPostIntegrityHealth;
  reclaimPolicy: BackendMediaUploadReclaimPolicyHealth;
  issues: BackendHealthIssue[];
};

const JOB_LOOKBACK_HOURS = 48;
const JOB_RUN_PAGE_SIZE = 1_000;
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
const PAYMENT_WEBHOOK_PROCESSING_FAILURE_DEGRADED_COUNT = 1;
const JOB_RECENT_FAILURE_WARNING_COUNT = 3;
// Mirrors MAX_PREVIEW_ATTEMPTS / MAX_RENDITION_ATTEMPTS in media-preview-repair.ts.
// Duplicated rather than imported so this ops route does not pull ffmpeg and
// sharp into its bundle; media-pipeline-health.test.ts asserts they stay equal.
const MEDIA_PREVIEW_MAX_ATTEMPTS = 3;
const MEDIA_RENDITION_MAX_ATTEMPTS = 3;
// Several hourly repair windows. Anything older is not "waiting its turn".
const MEDIA_PIPELINE_STALE_AFTER_MINUTES = 360;
/**
 * Caps on the recency samples (recent generations, AI usage, provider events)
 * and the completion queue. Queries ask for one row past the cap so overflow is
 * detectable without a COUNT — past it, every rate computed from the sample
 * describes the sample, not the window, and the report must say so instead of
 * quietly getting more optimistic as traffic grows.
 */
const HEALTH_RECENCY_SAMPLE_LIMIT = 1000;
const COMPLETION_QUEUE_SAMPLE_LIMIT = 200;
const MEDIA_PIPELINE_SAMPLE_LIMIT = 500;
const DATA_ACCESS_REMIX_SAMPLE_LIMIT = 25;
// A publish that is still writing its media rows is not a shell. One hour is
// far past the request timeout, so anything older failed rather than raced.
const SHELL_POST_STALE_AFTER_MINUTES = 60;
const SHELL_POST_SAMPLE_LIMIT = 100;
// post_media arrived in 20260609094006_post_media_gallery.sql, so the epoch is
// that migration's own timestamp (09:40:06Z), not midnight of that day. Media
// posts older than it legitimately carry no rows and are read through the
// legacy single-asset projection instead -- counting them would report a real
// post as deletable cruft. Production applied the migration at the following
// release, slightly after this, so a hit from that same day is still suspect:
// the runbook says verify before deleting.
const POST_MEDIA_GALLERY_EPOCH = '2026-06-09T09:40:06.000Z';

function minutesSince(timestamp: string, now: Date): number {
  const ms = now.getTime() - new Date(timestamp).getTime();
  return Math.max(0, Math.floor(ms / 60000));
}

function getBuildId(): string {
  return (
    process.env.RELEASE_GIT_SHA?.trim()
    || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.VERCEL_DEPLOYMENT_ID?.trim()
    || process.env.VERCEL_URL?.trim()
    || 'dev'
  );
}

async function loadRecentBackendJobRuns(
  client: SupabaseClient,
  startedAtOrAfter: string,
): Promise<BackendJobRunRow[]> {
  const jobNames = BACKEND_JOB_REGISTRY.map((job) => job.name);
  const rows: BackendJobRunRow[] = [];

  for (let offset = 0; ; offset += JOB_RUN_PAGE_SIZE) {
    const { data, error } = await client
      .from('backend_job_runs')
      .select('id,job_name,status,started_at,finished_at,duration_ms,skip_reason,error_message')
      .in('job_name', jobNames)
      .gte('started_at', startedAtOrAfter)
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + JOB_RUN_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data ?? []) as BackendJobRunRow[];
    rows.push(...page);
    if (page.length < JOB_RUN_PAGE_SIZE) return rows;
  }
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
  const latestFailure = jobRows.find((row) => row.status === 'failed') ?? null;
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
  // A flap the job has already recovered from must not hold this status (and
  // the release gate, which requires strictly ok) for the full lookback
  // window: 2026-09-01's account-deletion retries left releases refused for
  // two days after the job went green. The failure count stays on the job
  // payload either way; only an unrecovered failure streak warns.
  const recoveredSinceLastFailure = Boolean(
    lastHealthyRun
    && latestFailure
    && Date.parse(lastHealthyRun.started_at) > Date.parse(latestFailure.started_at),
  );
  if (
    status === 'ok'
    && recentFailures >= JOB_RECENT_FAILURE_WARNING_COUNT
    && !recoveredSinceLastFailure
  ) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'JOB_RECENT_FAILURES',
      message: `${job.name} had ${recentFailures} failed run(s) in the last ${JOB_LOOKBACK_HOURS} hours.`,
    });
  }
  if (
    status === 'ok'
    && job.name === 'account-deletion-resweeps'
    && latestFailure
    && (
      !lastSuccess
      || Date.parse(lastSuccess.started_at) < Date.parse(latestFailure.started_at)
    )
  ) {
    status = 'warning';
    issues.push({
      severity: 'warning',
      code: 'ACCOUNT_DELETION_CLEANUP_RETRY_PENDING',
      message: 'Account deletion cleanup failed and has not yet recorded a successful retry.',
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

function buildMediaPipelineHealth(
  renditionRows: MediaRenditionRow[],
  previewRows: MediaPreviewRow[],
  now: Date,
): { health: BackendMediaPipelineHealth; issues: BackendHealthIssue[] } {
  const renditionFailed = renditionRows.filter((row) => row.rendition_status === 'failed');
  const renditionExhausted = renditionFailed.filter(
    (row) => (row.rendition_attempt_count ?? 0) >= MEDIA_RENDITION_MAX_ATTEMPTS,
  );
  const previewFailed = previewRows.filter((row) => row.preview_status === 'failed');
  const previewExhausted = previewFailed.filter(
    (row) => (row.preview_attempt_count ?? 0) >= MEDIA_PREVIEW_MAX_ATTEMPTS,
  );
  const renditionPending = renditionRows.length - renditionFailed.length;
  const previewPending = previewRows.length - previewFailed.length;
  const oldestRendition = sortByTimestamp(renditionRows, (row) => row.created_at)[0] ?? null;
  const oldestPreview = sortByTimestamp(previewRows, (row) => row.created_at)[0] ?? null;
  const issues: BackendHealthIssue[] = [];

  // Exhausted rows are invisible to the repair sweep, so nothing will fix them
  // without an operator. This is the state that reads as green everywhere else.
  if (renditionExhausted.length > 0) {
    issues.push({
      severity: 'degraded',
      code: 'MEDIA_RENDITION_ATTEMPTS_EXHAUSTED',
      message: `${renditionExhausted.length} video(s) used all ${MEDIA_RENDITION_MAX_ATTEMPTS} rendition attempts and will never retry; the feed streams full-size source video for them.`,
    });
  }

  if (previewExhausted.length > 0) {
    issues.push({
      severity: 'degraded',
      code: 'MEDIA_PREVIEW_ATTEMPTS_EXHAUSTED',
      message: `${previewExhausted.length} media row(s) used all ${MEDIA_PREVIEW_MAX_ATTEMPTS} preview attempts and will never retry.`,
    });
  }

  const renditionRetryable = renditionFailed.length - renditionExhausted.length;
  if (renditionRetryable > 0) {
    issues.push({
      severity: 'warning',
      code: 'MEDIA_RENDITION_FAILURES',
      message: `${renditionRetryable} video rendition(s) failed and are awaiting retry.`,
    });
  }

  const staleRendition = oldestRendition?.created_at
    && minutesSince(oldestRendition.created_at, now) > MEDIA_PIPELINE_STALE_AFTER_MINUTES;
  if (staleRendition) {
    issues.push({
      severity: 'warning',
      code: 'MEDIA_RENDITION_BACKLOG_STALE',
      message: `The oldest unresolved video rendition has waited over ${MEDIA_PIPELINE_STALE_AFTER_MINUTES} minutes.`,
    });
  }

  return {
    health: {
      status: maxStatus(issues.map((issue) => issue.severity)),
      staleAfterMinutes: MEDIA_PIPELINE_STALE_AFTER_MINUTES,
      renditionPendingCount: renditionPending,
      renditionFailedCount: renditionFailed.length,
      renditionExhaustedCount: renditionExhausted.length,
      previewPendingCount: previewPending,
      previewFailedCount: previewFailed.length,
      previewExhaustedCount: previewExhausted.length,
      oldestUnresolvedRenditionAt: oldestRendition?.created_at ?? null,
      oldestUnresolvedPreviewAt: oldestPreview?.created_at ?? null,
      sampleTruncated: renditionRows.length >= MEDIA_PIPELINE_SAMPLE_LIMIT
        || previewRows.length >= MEDIA_PIPELINE_SAMPLE_LIMIT,
    },
    issues,
  };
}

function buildOrphanedShellPostHealth(
  rows: OrphanedShellPostRow[],
  probeError: { message?: string } | null,
): { health: BackendPostIntegrityHealth; issues: BackendHealthIssue[] } {
  const issues: BackendHealthIssue[] = [];

  if (probeError) {
    issues.push({
      severity: 'degraded',
      code: 'SHELL_POST_PROBE_FAILED',
      message: `Orphaned shell posts could not be counted (${probeError.message ?? 'unknown error'}).`,
    });
  }

  const oldest = sortByTimestamp(rows, (row) => row.created_at)[0] ?? null;
  // A warning, not degraded: every shell is private and unreachable, so this
  // reports accumulating cruft an operator should clear, not user-facing damage.
  if (rows.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'ORPHANED_MEDIA_SHELL_POSTS',
      message: `${rows.length} media post(s) older than ${SHELL_POST_STALE_AFTER_MINUTES} minutes have no media rows; a compensating delete failed after the media write did.`,
    });
  }

  return {
    health: {
      status: maxStatus(issues.map((issue) => issue.severity)),
      staleAfterMinutes: SHELL_POST_STALE_AFTER_MINUTES,
      shellPostCount: rows.length,
      oldestShellPostCreatedAt: oldest?.created_at ?? null,
      sampleTruncated: rows.length >= SHELL_POST_SAMPLE_LIMIT,
      probeReadError: probeError ? probeError.message ?? 'unknown error' : null,
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
  const countsByModel: Record<string, number> = {};
  const failedByModel: Record<string, number> = {};
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let failedEventCount = 0;
  let timeoutCount = 0;
  let networkErrorCount = 0;
  let slowCount = 0;
  let paymentWebhookProcessingFailureCount = 0;

  for (const row of rows) {
    const outcome = row.outcome ?? 'unknown';
    const serviceName = row.service_name ?? 'unknown';
    const durationMs = getPositiveInteger(row.duration_ms);
    // Unattributed rows are skipped for the per-model breakdown rather than
    // bucketed as 'unknown', which would otherwise collect every payment, FX,
    // and push call under a single synthetic model.
    const modelId = typeof row.model_id === 'string' && row.model_id.trim()
      ? row.model_id.trim()
      : null;
    totalDurationMs += durationMs;
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    incrementCount(countsByOutcome, outcome);
    incrementCount(countsByService, serviceName);
    if (modelId) incrementCount(countsByModel, modelId);

    if (outcome !== 'success') {
      failedEventCount += 1;
      incrementCount(failedByService, serviceName);
      if (modelId) incrementCount(failedByModel, modelId);
      if (PAYMENT_WEBHOOK_PROCESSING_SERVICE_NAMES.includes(serviceName)) {
        paymentWebhookProcessingFailureCount += 1;
      }
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

  if (paymentWebhookProcessingFailureCount >= PAYMENT_WEBHOOK_PROCESSING_FAILURE_DEGRADED_COUNT) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'PAYMENT_WEBHOOK_PROCESSING_FAILURE',
      message: `${paymentWebhookProcessingFailureCount} payment webhook processing failure(s) were recorded in the last ${PROVIDER_DEPENDENCY_RECENT_WINDOW_MINUTES} minutes.`,
    });
  }

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
    // maxStatus keeps this warning from downgrading an already-degraded status
    // (payment webhook failures also count toward failedEventCount).
    status = maxStatus([status, 'warning']);
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
      countsByModel,
      failedByModel,
      paymentWebhookProcessingFailureCount,
      oldestRecentEventAt: oldestRecentEvent?.created_at ?? null,
    },
    issues,
  };
}

function buildDataAccessHealth(
  posts: RemixablePostRow[],
  sources: RemixSourceProjectionRow[],
  projectionError: { message?: string } | null,
): { health: BackendDataAccessHealth; issues: BackendHealthIssue[] } {
  const sampled = posts.length;

  // A read error here is the regression itself: the privileged projection is
  // the one the remix service depends on, so it can never be a warning.
  if (projectionError) {
    return {
      health: {
        status: 'degraded',
        remixSourcesSampled: sampled,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: 0,
        projectionReadError: projectionError.message ?? 'unknown error',
      },
      issues: [{
        severity: 'degraded',
        code: 'DATA_ACCESS_REMIX_PROJECTION_UNREADABLE',
        message:
          'The privileged generations projection behind remix could not be read: '
          + `${projectionError.message ?? 'unknown error'}. Check grants and policies on public.generations.`,
      }],
    };
  }

  // Nothing to prove on an empty environment. Reporting ok with a zero sample
  // is honest; failing here would just make fresh projects unreleasable.
  if (sampled === 0) {
    return {
      health: {
        status: 'ok',
        remixSourcesSampled: 0,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: 0,
        projectionReadError: null,
      },
      issues: [],
    };
  }

  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  let resolved = 0;
  let gateBlocked = 0;
  for (const post of posts) {
    const source = post.generation_id ? sourcesById.get(post.generation_id) : undefined;
    if (!source) continue;
    // Mirrors the gate in showcase-remix-service: still public, and owned by
    // the post's creator.
    if (source.is_public === true && source.user_id && source.user_id === post.user_id) {
      resolved += 1;
    } else {
      gateBlocked += 1;
    }
  }

  const unreadable = sampled - resolved - gateBlocked;

  // Every sampled post failing to resolve is the silent-breakage signature:
  // the rows exist and are public, but the source read comes back empty.
  if (resolved === 0) {
    return {
      health: {
        status: 'degraded',
        remixSourcesSampled: sampled,
        remixSourcesResolved: 0,
        remixSourcesGateBlocked: gateBlocked,
        projectionReadError: null,
      },
      issues: [{
        severity: 'degraded',
        code: 'DATA_ACCESS_REMIX_SOURCE_UNRESOLVABLE',
        message:
          `None of ${sampled} public generation-backed post(s) could resolve a remixable source. `
          + 'Remix is broken for every viewer.',
      }],
    };
  }

  // Some resolving and some not is data drift (an unpublished or relinked
  // generation), not a contract break — surface it without blocking a release.
  if (unreadable > 0) {
    return {
      health: {
        status: 'warning',
        remixSourcesSampled: sampled,
        remixSourcesResolved: resolved,
        remixSourcesGateBlocked: gateBlocked,
        projectionReadError: null,
      },
      issues: [{
        severity: 'warning',
        code: 'DATA_ACCESS_REMIX_SOURCE_MISSING',
        message:
          `${unreadable} of ${sampled} public generation-backed post(s) have no readable source generation.`,
      }],
    };
  }

  return {
    health: {
      status: 'ok',
      remixSourcesSampled: sampled,
      remixSourcesResolved: resolved,
      remixSourcesGateBlocked: gateBlocked,
      projectionReadError: null,
    },
    issues: [],
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
    jobRows,
    recentGenerationsResult,
    stalledGenerationsResult,
    pendingWithoutProviderTaskResult,
    completionQueueResult,
    unresolvedRenditionResult,
    unresolvedPreviewResult,
    recentAiUsageResult,
    stalePendingAiUsageResult,
    recentProviderDependencyResult,
    remixablePostsResult,
  ] = await Promise.all([
    loadRecentBackendJobRuns(client, jobSince),
    client
      .from('generations')
      .select('status,created_at,cost')
      .gte('created_at', recentGenerationSince)
      .limit(HEALTH_RECENCY_SAMPLE_LIMIT + 1),
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
      .limit(COMPLETION_QUEUE_SAMPLE_LIMIT + 1),
    // Only unresolved rows: a backlog that cannot clear is the signal, and
    // filtering to it keeps failures from being pushed out of the sample by
    // however many derivatives have already succeeded.
    client
      .from('post_media')
      .select('rendition_status,rendition_attempt_count,created_at')
      .eq('media_kind', 'video')
      .in('rendition_status', ['pending', 'processing', 'failed'])
      .order('created_at', { ascending: true })
      .limit(MEDIA_PIPELINE_SAMPLE_LIMIT),
    client
      .from('post_media')
      .select('preview_status,preview_attempt_count,created_at')
      .in('preview_status', ['pending', 'processing', 'failed'])
      .order('created_at', { ascending: true })
      .limit(MEDIA_PIPELINE_SAMPLE_LIMIT),
    client
      .from('ai_usage_events')
      .select('feature,status,medium,cost,created_at')
      .gte('created_at', recentAiUsageSince)
      .limit(HEALTH_RECENCY_SAMPLE_LIMIT + 1),
    client
      .from('ai_usage_events')
      .select('feature,status,medium,cost,created_at')
      .eq('status', 'pending')
      .lt('created_at', staleAiUsagePendingBefore)
      .order('created_at', { ascending: true })
      .limit(50),
    client
      .from('provider_dependency_events')
      .select('service_name,outcome,duration_ms,timeout_ms,status,created_at,model_id')
      .gte('created_at', recentProviderDependencySince)
      .order('created_at', { ascending: true })
      .limit(HEALTH_RECENCY_SAMPLE_LIMIT + 1),
    // Same filter findPublicPostReferenceByIdOrGenerationId applies, so the
    // sample is exactly the set a viewer could press Remix on.
    client
      .from('posts')
      .select('id,user_id,generation_id')
      .eq('visibility', 'public')
      .eq('review_status', 'visible')
      .is('archived_at', null)
      .not('generation_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(DATA_ACCESS_REMIX_SAMPLE_LIMIT),
  ]);

  if (recentGenerationsResult.error) throw recentGenerationsResult.error;
  if (stalledGenerationsResult.error) throw stalledGenerationsResult.error;
  if (pendingWithoutProviderTaskResult.error) throw pendingWithoutProviderTaskResult.error;
  if (completionQueueResult.error) throw completionQueueResult.error;
  if (unresolvedRenditionResult.error) throw unresolvedRenditionResult.error;
  if (unresolvedPreviewResult.error) throw unresolvedPreviewResult.error;
  if (recentAiUsageResult.error) throw recentAiUsageResult.error;
  if (stalePendingAiUsageResult.error) throw stalePendingAiUsageResult.error;
  if (recentProviderDependencyResult.error) throw recentProviderDependencyResult.error;

  // The extra probe row is dropped before any builder sees it, so counts stay
  // consistent with the caps; what survives is the knowledge that a cap hit.
  const truncatedHealthSamples: string[] = [];
  function healthSample<TRow>(source: string, rows: TRow[], cap: number): TRow[] {
    if (rows.length <= cap) return rows;
    truncatedHealthSamples.push(source);
    return rows.slice(0, cap);
  }

  const jobResults = BACKEND_JOB_REGISTRY.map((job) => buildJobHealth(job, jobRows, now));
  const schedulerResult = buildSchedulerHealth();
  const generationResult = buildGenerationHealth(
    healthSample('generations', (recentGenerationsResult.data ?? []) as GenerationStatusRow[], HEALTH_RECENCY_SAMPLE_LIMIT),
    (stalledGenerationsResult.data ?? []) as StalledGenerationRow[],
    (pendingWithoutProviderTaskResult.data ?? []) as PendingGenerationWithoutProviderTaskRow[],
  );
  const completionQueueResultHealth = buildCompletionQueueHealth(
    healthSample('generation_completion_jobs', (completionQueueResult.data ?? []) as GenerationCompletionQueueRow[], COMPLETION_QUEUE_SAMPLE_LIMIT),
    now,
  );
  const mediaPipelineResult = buildMediaPipelineHealth(
    (unresolvedRenditionResult.data ?? []) as MediaRenditionRow[],
    (unresolvedPreviewResult.data ?? []) as MediaPreviewRow[],
    now,
  );
  const aiUsageResult = buildAiUsageHealth(
    healthSample('ai_usage_events', (recentAiUsageResult.data ?? []) as AiUsageEventRow[], HEALTH_RECENCY_SAMPLE_LIMIT),
    (stalePendingAiUsageResult.data ?? []) as AiUsageEventRow[],
  );
  const providerDependencyResult = buildProviderDependencyHealth(
    healthSample('provider_dependency_events', (recentProviderDependencyResult.data ?? []) as ProviderDependencyEventRow[], HEALTH_RECENCY_SAMPLE_LIMIT),
  );

  // Deliberately not thrown like its siblings: a failure to read this
  // projection is the exact regression being watched for, so it has to be
  // reported as degraded health rather than collapse the endpoint into a 500
  // that says nothing about which contract broke.
  const remixablePosts = (remixablePostsResult.data ?? []) as RemixablePostRow[];
  const remixSourceIds = remixablePosts
    .map((post) => post.generation_id)
    .filter((id): id is string => Boolean(id));
  let remixProjectionError: { message?: string } | null = remixablePostsResult.error
    ? { message: `public posts could not be listed (${remixablePostsResult.error.message})` }
    : null;
  let remixSources: RemixSourceProjectionRow[] = [];
  if (!remixProjectionError && remixSourceIds.length > 0) {
    // The full remix projection, not just the gate columns: prompt and
    // workflow_settings are the ones the hardening revoked, so naming them
    // here is what makes this probe fail if they are ever revoked again.
    const remixSourceResult = await client
      .from('generations')
      .select('id, user_id, is_public, share_input_media_for_remix, category, prompt, workflow_settings')
      .in('id', remixSourceIds);
    if (remixSourceResult.error) {
      remixProjectionError = remixSourceResult.error;
    } else {
      remixSources = (remixSourceResult.data ?? []) as RemixSourceProjectionRow[];
    }
  }
  const dataAccessResult = buildDataAccessHealth(
    remixablePosts,
    remixSources,
    remixProjectionError,
  );

  // Same tolerance as the remix projection above: a probe that cannot read must
  // report itself as degraded, not collapse the whole endpoint into a 500.
  // `post_media!left(id)` + `.is('post_media', null)` is a server-side anti-join
  // -- the candidate set is otherwise every media post ever published.
  const shellPostsResult = await client
    .from('posts')
    .select('id, visibility, created_at, post_media!left(id)')
    .in('post_format', ['media', 'mixed'])
    // Generation-backed posts keep their media on posts.showcase_asset_path and
    // legitimately have no post_media rows.
    .is('generation_id', null)
    .is('post_media', null)
    .gte('created_at', POST_MEDIA_GALLERY_EPOCH)
    .lt('created_at', new Date(now.getTime() - SHELL_POST_STALE_AFTER_MINUTES * 60_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(SHELL_POST_SAMPLE_LIMIT);
  const postIntegrityResult = buildOrphanedShellPostHealth(
    (shellPostsResult.data ?? []) as OrphanedShellPostRow[],
    shellPostsResult.error ?? null,
  );
  const environment = environmentVariables
    ? collectBackendEnvironmentHealth(environmentVariables)
    : null;
  const reclaimPolicy = getMediaUploadReclaimPolicy({
    environment: environmentVariables ?? process.env,
  });
  const environmentIssues: BackendHealthIssue[] = environment?.status === 'degraded'
    ? [
      ...(environment.missing.length > 0 ? [{
        severity: 'degraded',
        code: 'ENVIRONMENT_MISSING_REQUIRED',
        message: `Missing required backend environment capabilities: ${environment.missing.join(', ')}.`,
      } satisfies BackendHealthIssue] : []),
      ...(environment.invalid.length > 0 ? [{
        severity: 'degraded',
        code: 'ENVIRONMENT_INVALID_PRODUCTION_SETTING',
        message: `Unsafe production environment settings: ${environment.invalid.join(', ')}.`,
      } satisfies BackendHealthIssue] : []),
    ]
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
  const healthSampleIssues: BackendHealthIssue[] = truncatedHealthSamples.length > 0 ? [{
    severity: 'warning',
    code: 'HEALTH_SAMPLE_TRUNCATED',
    message: `Health collectors read only their first sample of rows from: ${truncatedHealthSamples.join(', ')}. Counts and rates derived from them describe the sample, not the window.`,
  }] : [];
  // Collected separately from the sampled reads above, and deliberately so: a
  // queue's age has to come from a targeted "oldest due row" probe, because
  // deriving it from a capped sample understates it exactly when the queue is
  // deep enough to matter.
  const queueAgeResult = await collectBackendQueueAgeHealth(client as unknown as QueueClient, now);

  // Retention lag, not just table size: a capped hourly prune can silently stop
  // keeping up while row counts still look like ordinary growth.
  const feedRetentionLagResult = await collectFeedRetentionLag(client, now);

  const issues = [
    ...healthSampleIssues,
    ...schedulerResult.issues,
    ...jobResults.flatMap((result) => result.issues),
    ...generationResult.issues,
    ...completionQueueResultHealth.issues,
    ...queueAgeResult.issues,
    ...feedRetentionLagResult.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
    ...mediaPipelineResult.issues,
    ...aiUsageResult.issues,
    ...providerDependencyResult.issues,
    ...dataAccessResult.issues,
    ...postIntegrityResult.issues,
    ...environmentIssues,
  ];
  const componentStatuses = [
    schedulerResult.health.status,
    ...jobResults.map((result) => result.health.status),
    generationResult.health.status,
    completionQueueResultHealth.health.status,
    queueAgeResult.health.status,
    feedRetentionLagResult.status,
    mediaPipelineResult.health.status,
    aiUsageResult.health.status,
    providerDependencyResult.health.status,
    dataAccessResult.health.status,
    postIntegrityResult.health.status,
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
    queueAge: queueAgeResult.health,
    feedRetentionLag: feedRetentionLagResult,
    mediaPipeline: mediaPipelineResult.health,
    aiUsage: aiUsageResult.health,
    providerDependencies: providerDependencyResult.health,
    dataAccess: dataAccessResult.health,
    postIntegrity: postIntegrityResult.health,
    reclaimPolicy: {
      abandonedReclaimConfigured: reclaimPolicy.flagConfigured,
      minimumAppVersion: reclaimPolicy.minimumAppVersion,
      abandonedReclaimEffective: reclaimPolicy.effectiveEnabled,
    },
    issues,
  };
}
