export type BackendJobName =
  | 'account-deletion-resweeps'
  | 'backend-alert-delivery'
  | 'feed-maintenance'
  | 'generation-completions'
  | 'generation-model-verification'
  | 'media-preview-repair'
  | 'media-upload-reclaim'
  | 'mobile-push-receipts'
  | 'operational-data-retention'
  | 'referral-reward-reconciliation'
  | 'workflow-run-steps';

export type BackendJobSchedulerDefinition = {
  route: '/api/cron/backend-jobs';
  schedule: string;
  cadenceMinutes: number;
  dailyInvocations: number;
  maxDurationSeconds: number;
};

/**
 * How a logical job reaches a function instance (F14).
 *
 * `scheduler` — dispatched inside the shared `/api/cron/backend-jobs`
 * invocation alongside every other due job. Cheap, and fine for work that is
 * bounded and light.
 *
 * `dedicated` — Vercel cron calls the job's own route, so it runs in its own
 * function instance. This is the only thing that provides real *memory*
 * isolation: bounded concurrency and time budgets stop a job monopolising the
 * 300 seconds, but an OOM or a hard crash takes down every job sharing the
 * invocation. Reserved for the media-heavy jobs, which stage videos up to
 * 250 MB and shell out to ffmpeg.
 */
export type BackendJobDispatch = 'scheduler' | 'dedicated';

export type BackendJobDefinition = {
  name: BackendJobName;
  route: `/api/cron/${string}`;
  schedule: string;
  dispatch: BackendJobDispatch;
  cadenceMinutes: number;
  dailyInvocations: number;
  maxDurationSeconds: number;
  lockTtlSeconds: number;
  noWorkSkipReason: string;
  maxMissedRunsBeforeDegraded: number;
  healthExpectedMaxAgeMinutes: number;
};

/**
 * Ceiling on *Vercel cron* invocations per day, not logical job runs.
 *
 * Currently 144 (scheduler) + 144 (generation-completions) + 24
 * (media-preview-repair) = 312, leaving room for one more ten-minute dedicated
 * cron before this needs revisiting. Vercel Pro allows 40 cron entries, so the
 * binding constraint is cost rather than the plan — and under Fluid compute
 * billing follows CPU time, so a mostly-idle extra cron is close to free.
 */
export const BACKEND_JOB_DAILY_INVOCATION_BUDGET = 456;

function parseSupportedCronSchedule(schedule: string): {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
} {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.trim().split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error(`Unsupported cron schedule: ${schedule}`);
  }
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    throw new Error(`Unsupported cron schedule: ${schedule}`);
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function getCronScheduleCadenceMinutes(schedule: string): number {
  const { minute, hour } = parseSupportedCronSchedule(schedule);

  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hour === '*') {
    const interval = Number(everyMinuteMatch[1]);
    if (Number.isInteger(interval) && interval > 0 && interval <= 60) return interval;
  }

  if (/^\d+$/.test(minute) && hour === '*') {
    return 60;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHourMatch) {
    const interval = Number(everyHourMatch[1]);
    if (Number.isInteger(interval) && interval > 0 && interval <= 24) return interval * 60;
  }

  throw new Error(`Unsupported cron schedule: ${schedule}`);
}

export function getCronScheduleDailyInvocations(schedule: string): number {
  const { minute, hour } = parseSupportedCronSchedule(schedule);

  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hour === '*') {
    const interval = Number(everyMinuteMatch[1]);
    if (Number.isInteger(interval) && interval > 0 && interval <= 60) {
      return (Math.floor(59 / interval) + 1) * 24;
    }
  }

  if (/^\d+$/.test(minute) && hour === '*') {
    return 24;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHourMatch) {
    const interval = Number(everyHourMatch[1]);
    if (Number.isInteger(interval) && interval > 0 && interval <= 24) {
      return Math.floor(23 / interval) + 1;
    }
  }

  throw new Error(`Unsupported cron schedule: ${schedule}`);
}

export function isCronScheduleDueAt(
  schedule: string,
  timestampMs: number,
  options: { windowMinutes?: number } = {},
): boolean {
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Cron due timestamp must be a finite number');
  }

  const { minute, hour } = parseSupportedCronSchedule(schedule);
  const now = new Date(timestampMs);
  const currentMinute = now.getUTCMinutes();
  const currentHour = now.getUTCHours();
  const windowMinutes = options.windowMinutes ?? 1;

  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 60) {
    throw new Error('Cron due window must be between 1 and 60 minutes');
  }

  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hour === '*') {
    const interval = Number(everyMinuteMatch[1]);
    if (Number.isInteger(interval) && interval > 0 && interval <= 60) {
      return currentMinute % interval < windowMinutes;
    }
  }

  if (/^\d+$/.test(minute) && hour === '*') {
    const scheduledMinute = Number(minute);
    return (currentMinute - scheduledMinute + 60) % 60 < windowMinutes;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHourMatch) {
    const scheduledMinute = Number(minute);
    const hourInterval = Number(everyHourMatch[1]);
    if (Number.isInteger(hourInterval) && hourInterval > 0 && hourInterval <= 24) {
      const minutesSinceScheduledHour = ((currentHour % hourInterval) * 60)
        + ((currentMinute - scheduledMinute + 60) % 60);
      return minutesSinceScheduledHour < windowMinutes;
    }
  }

  throw new Error(`Unsupported cron schedule: ${schedule}`);
}

function defineBackendJob(
  definition:
    & Omit<
      BackendJobDefinition,
      'cadenceMinutes' | 'dailyInvocations' | 'healthExpectedMaxAgeMinutes' | 'dispatch'
    >
    & { dispatch?: BackendJobDispatch },
): BackendJobDefinition {
  const cadenceMinutes = getCronScheduleCadenceMinutes(definition.schedule);
  const dailyInvocations = getCronScheduleDailyInvocations(definition.schedule);
  return {
    ...definition,
    // Shared dispatch stays the default: isolation costs a cron entry, so a job
    // has to earn it by being able to take the invocation down.
    dispatch: definition.dispatch ?? 'scheduler',
    cadenceMinutes,
    dailyInvocations,
    healthExpectedMaxAgeMinutes: cadenceMinutes * definition.maxMissedRunsBeforeDegraded,
  };
}

export const BACKEND_JOB_SCHEDULER = {
  route: '/api/cron/backend-jobs',
  schedule: '*/10 * * * *',
  cadenceMinutes: getCronScheduleCadenceMinutes('*/10 * * * *'),
  dailyInvocations: getCronScheduleDailyInvocations('*/10 * * * *'),
  maxDurationSeconds: 300,
} as const satisfies BackendJobSchedulerDefinition;

export const BACKEND_JOB_REGISTRY = [
  defineBackendJob({
    name: 'account-deletion-resweeps',
    route: '/api/cron/account-deletion-resweeps',
    schedule: '*/10 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_due_account_deletion_cleanup',
    maxMissedRunsBeforeDegraded: 3,
  }),
  defineBackendJob({
    name: 'backend-alert-delivery',
    route: '/api/cron/backend-alert-delivery',
    schedule: '*/10 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'alert_delivery_not_configured',
    maxMissedRunsBeforeDegraded: 4,
  }),
  defineBackendJob({
    name: 'feed-maintenance',
    route: '/api/cron/feed-maintenance',
    schedule: '20 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_feed_maintenance_work',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    // F14: dedicated. Four completion workers each staging a video up to 250 MB
    // can need ~1 GB of function temp space, so this is the job most able to
    // OOM an invocation and take completions, push receipts, alerts and
    // retention down with it.
    name: 'generation-completions',
    route: '/api/cron/generation-completions',
    schedule: '*/10 * * * *',
    dispatch: 'dedicated',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_due_jobs',
    maxMissedRunsBeforeDegraded: 3,
  }),
  defineBackendJob({
    name: 'generation-model-verification',
    route: '/api/cron/generation-model-verification',
    schedule: '30 */24 * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_published_generation_models',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    // F14: dedicated. Shells out to ffmpeg, which is memory-hungry and was the
    // reason F2's sweep concurrency had to stay at one while this shared an
    // invocation with everything else.
    name: 'media-preview-repair',
    route: '/api/cron/media-preview-repair',
    schedule: '*/10 * * * *',
    dispatch: 'dedicated',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_repairable_media',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    // Daily for the same reason as retention: the work is bounded per run and a
    // backlog simply drains over subsequent days. Nothing downstream waits on
    // a staged object being collected promptly.
    name: 'media-upload-reclaim',
    route: '/api/cron/media-upload-reclaim',
    schedule: '10 */24 * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_reclaimable_media_uploads',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    name: 'mobile-push-receipts',
    route: '/api/cron/mobile-push-receipts',
    schedule: '*/10 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_pending_receipts',
    maxMissedRunsBeforeDegraded: 4,
  }),
  defineBackendJob({
    // Daily is deliberate: retention is bounded per run and a backlog simply
    // drains over subsequent days rather than needing frequent sweeps.
    name: 'operational-data-retention',
    route: '/api/cron/operational-data-retention',
    schedule: '50 */24 * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_prunable_operational_data',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    name: 'referral-reward-reconciliation',
    route: '/api/cron/referral-rewards',
    schedule: '40 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_unsettled_referral_rewards',
    maxMissedRunsBeforeDegraded: 2,
  }),
  defineBackendJob({
    // F12: before this entry the registry had no workflow job at all, so a
    // recycled function stranded a run permanently -- the only things advancing
    // it were a process-local monitor map and a state-mutating GET.
    name: 'workflow-run-steps',
    route: '/api/cron/workflow-run-steps',
    schedule: '*/10 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_due_workflow_run_steps',
    maxMissedRunsBeforeDegraded: 3,
  }),
] as const satisfies readonly BackendJobDefinition[];

export const BACKEND_JOBS_BY_NAME = Object.fromEntries(
  BACKEND_JOB_REGISTRY.map((job) => [job.name, job]),
) as Record<BackendJobName, BackendJobDefinition>;

/**
 * Jobs the shared scheduler is responsible for on this tick.
 *
 * Dedicated jobs are excluded deliberately: Vercel cron calls their own routes,
 * and dispatching them here too would run them in the shared invocation as
 * well, which is exactly the isolation F14 exists to create. The job lock would
 * make the duplicate harmless but pointless.
 */
export function getDueBackendJobs(timestampMs: number): BackendJobDefinition[] {
  return BACKEND_JOB_REGISTRY.filter((job) => (
    job.dispatch === 'scheduler'
    && isCronScheduleDueAt(job.schedule, timestampMs, {
      windowMinutes: BACKEND_JOB_SCHEDULER.cadenceMinutes,
    })
  ));
}

/** Logical jobs that Vercel cron invokes directly, in their own instance. */
export const BACKEND_JOB_DEDICATED_CRONS = BACKEND_JOB_REGISTRY
  .filter((job) => job.dispatch === 'dedicated');

/**
 * Every Vercel cron entry this repo expects, scheduler included. `vercel.json`
 * is asserted against this so the two cannot drift.
 */
export const BACKEND_JOB_VERCEL_CRONS: readonly { path: string; schedule: string }[] = [
  { path: BACKEND_JOB_SCHEDULER.route, schedule: BACKEND_JOB_SCHEDULER.schedule },
  ...BACKEND_JOB_DEDICATED_CRONS.map((job) => ({ path: job.route, schedule: job.schedule })),
];

/** Actual Vercel cron invocations per day — the thing the budget bounds. */
export function getBackendJobVercelDailyInvocations(): number {
  return BACKEND_JOB_VERCEL_CRONS.reduce(
    (total, cron) => total + getCronScheduleDailyInvocations(cron.schedule),
    0,
  );
}
