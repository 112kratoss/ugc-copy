export type BackendJobName =
  | 'backend-alert-delivery'
  | 'feed-maintenance'
  | 'generation-completions'
  | 'generation-model-verification'
  | 'media-preview-repair'
  | 'mobile-push-receipts'
  | 'operational-data-retention'
  | 'referral-reward-reconciliation';

export type BackendJobSchedulerDefinition = {
  route: '/api/cron/backend-jobs';
  schedule: string;
  cadenceMinutes: number;
  dailyInvocations: number;
  maxDurationSeconds: number;
};

export type BackendJobDefinition = {
  name: BackendJobName;
  route: `/api/cron/${string}`;
  schedule: string;
  cadenceMinutes: number;
  dailyInvocations: number;
  maxDurationSeconds: number;
  lockTtlSeconds: number;
  noWorkSkipReason: string;
  maxMissedRunsBeforeDegraded: number;
  healthExpectedMaxAgeMinutes: number;
};

export const BACKEND_JOB_DAILY_INVOCATION_BUDGET = 180;

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
  definition: Omit<BackendJobDefinition, 'cadenceMinutes' | 'dailyInvocations' | 'healthExpectedMaxAgeMinutes'>,
): BackendJobDefinition {
  const cadenceMinutes = getCronScheduleCadenceMinutes(definition.schedule);
  const dailyInvocations = getCronScheduleDailyInvocations(definition.schedule);
  return {
    ...definition,
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
    name: 'generation-completions',
    route: '/api/cron/generation-completions',
    schedule: '*/10 * * * *',
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
    name: 'media-preview-repair',
    route: '/api/cron/media-preview-repair',
    schedule: '0 * * * *',
    maxDurationSeconds: 300,
    lockTtlSeconds: 14 * 60,
    noWorkSkipReason: 'no_repairable_media',
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
] as const satisfies readonly BackendJobDefinition[];

export const BACKEND_JOBS_BY_NAME = Object.fromEntries(
  BACKEND_JOB_REGISTRY.map((job) => [job.name, job]),
) as Record<BackendJobName, BackendJobDefinition>;

export function getDueBackendJobs(timestampMs: number): BackendJobDefinition[] {
  return BACKEND_JOB_REGISTRY.filter((job) => (
    isCronScheduleDueAt(job.schedule, timestampMs, {
      windowMinutes: BACKEND_JOB_SCHEDULER.cadenceMinutes,
    })
  ));
}
