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
};

type StalledGenerationRow = {
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
  recentCounts: Record<string, number>;
  stalledActiveCount: number;
  oldestStalledCreatedAt: string | null;
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
  issues: BackendHealthIssue[];
};

const JOB_THRESHOLDS: Array<{ name: string; expectedMaxAgeMinutes: number }> = [
  { name: 'media-preview-repair', expectedMaxAgeMinutes: 60 },
  { name: 'mobile-push-receipts', expectedMaxAgeMinutes: 36 * 60 },
];

const JOB_LOOKBACK_HOURS = 48;
const GENERATION_RECENT_WINDOW_MINUTES = 60;
const GENERATION_STALLED_AFTER_MINUTES = 60;

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
): { health: BackendGenerationHealth; issues: BackendHealthIssue[] } {
  const recentCounts = recentRows.reduce<Record<string, number>>((counts, row) => {
    const status = row.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const issues: BackendHealthIssue[] = [];
  const stalledActiveCount = stalledRows.length;

  let status: BackendHealthStatus = 'ok';
  if (stalledActiveCount > 0) {
    status = 'degraded';
    issues.push({
      severity: 'degraded',
      code: 'GENERATION_STALLED_ACTIVE',
      message: `${stalledActiveCount} active generation(s) are older than ${GENERATION_STALLED_AFTER_MINUTES} minutes.`,
    });
  }

  return {
    health: {
      status,
      recentWindowMinutes: GENERATION_RECENT_WINDOW_MINUTES,
      stalledAfterMinutes: GENERATION_STALLED_AFTER_MINUTES,
      recentCounts,
      stalledActiveCount,
      oldestStalledCreatedAt: stalledRows[0]?.created_at ?? null,
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

  const [jobRunsResult, recentGenerationsResult, stalledGenerationsResult] = await Promise.all([
    client
      .from('backend_job_runs')
      .select('job_name,status,started_at,finished_at,duration_ms,skip_reason,error_message')
      .gte('started_at', jobSince)
      .order('started_at', { ascending: false })
      .limit(200),
    client
      .from('generations')
      .select('status,created_at')
      .gte('created_at', recentGenerationSince)
      .limit(1000),
    client
      .from('generations')
      .select('created_at')
      .in('status', ['waiting', 'processing'])
      .lt('created_at', stalledBefore)
      .order('created_at', { ascending: true })
      .limit(50),
  ]);

  if (jobRunsResult.error) throw jobRunsResult.error;
  if (recentGenerationsResult.error) throw recentGenerationsResult.error;
  if (stalledGenerationsResult.error) throw stalledGenerationsResult.error;

  const jobRows = (jobRunsResult.data ?? []) as BackendJobRunRow[];
  const jobResults = JOB_THRESHOLDS.map((job) => buildJobHealth(job, jobRows, now));
  const generationResult = buildGenerationHealth(
    (recentGenerationsResult.data ?? []) as GenerationStatusRow[],
    (stalledGenerationsResult.data ?? []) as StalledGenerationRow[],
  );
  const catalog = buildGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  });
  const issues = [
    ...jobResults.flatMap((result) => result.issues),
    ...generationResult.issues,
  ];
  const componentStatuses = [
    ...jobResults.map((result) => result.health.status),
    generationResult.health.status,
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
    issues,
  };
}
