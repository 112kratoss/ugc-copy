import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export type BackendModerationHealthStatus = 'ok' | 'warning' | 'degraded';

export type BackendModerationHealthIssue = {
  severity: Exclude<BackendModerationHealthStatus, 'ok'>;
  code: string;
  message: string;
};

export type BackendModerationQueuePolicy = {
  ageWarningMinutes: number;
  ageDegradedMinutes: number;
  countWarning: number;
  countDegraded: number;
};

export type BackendModerationHealth = {
  status: BackendModerationHealthStatus;
  checkedAt: string;
  policy: BackendModerationQueuePolicy;
  queue: {
    postReportCount: number;
    subjectReportCount: number;
    totalOpenCount: number;
    oldestCreatedAt: string | null;
    oldestAgeMinutes: number | null;
  };
  issues: BackendModerationHealthIssue[];
};

type BuildBackendModerationHealthInput = {
  postReportCount: number;
  subjectReportCount: number;
  oldestPostReportCreatedAt: string | null;
  oldestSubjectReportCreatedAt: string | null;
  now?: Date;
  policy?: Partial<BackendModerationQueuePolicy>;
};

type ModerationQueueRow = {
  created_at: string | null;
};

const DEFAULT_MODERATION_QUEUE_POLICY: BackendModerationQueuePolicy = {
  ageWarningMinutes: 4 * 60,
  ageDegradedMinutes: 24 * 60,
  countWarning: 10,
  countDegraded: 25,
};

function normalizedCount(value: number | null | undefined): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function oldestTimestamp(values: Array<string | null>): string | null {
  const validTimestamps = values
    .map((value) => {
      if (!value) return null;
      const time = Date.parse(value);
      return Number.isFinite(time) ? { value, time } : null;
    })
    .filter((candidate): candidate is { value: string; time: number } => candidate !== null)
    .sort((left, right) => left.time - right.time);

  return validTimestamps[0]?.value ?? null;
}

function ageMinutes(createdAt: string | null, now: Date): number | null {
  if (!createdAt) return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return Math.max(0, Math.floor((now.getTime() - createdAtMs) / 60_000));
}

function maxStatus(statuses: BackendModerationHealthStatus[]): BackendModerationHealthStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function normalizedPolicy(
  overrides: Partial<BackendModerationQueuePolicy> | undefined,
): BackendModerationQueuePolicy {
  return {
    ...DEFAULT_MODERATION_QUEUE_POLICY,
    ...overrides,
  };
}

export function buildBackendModerationHealth({
  postReportCount,
  subjectReportCount,
  oldestPostReportCreatedAt,
  oldestSubjectReportCreatedAt,
  now = new Date(),
  policy: policyOverrides,
}: BuildBackendModerationHealthInput): BackendModerationHealth {
  const policy = normalizedPolicy(policyOverrides);
  const normalizedPostReportCount = normalizedCount(postReportCount);
  const normalizedSubjectReportCount = normalizedCount(subjectReportCount);
  const totalOpenCount = normalizedPostReportCount + normalizedSubjectReportCount;
  const oldestCreatedAt = oldestTimestamp([
    oldestPostReportCreatedAt,
    oldestSubjectReportCreatedAt,
  ]);
  const oldestAgeMinutes = ageMinutes(oldestCreatedAt, now);
  const issues: BackendModerationHealthIssue[] = [];

  if (oldestAgeMinutes !== null && oldestAgeMinutes >= policy.ageDegradedMinutes) {
    issues.push({
      severity: 'degraded',
      code: 'MODERATION_QUEUE_AGE_SLO_BREACH',
      message: `The oldest open moderation report is ${oldestAgeMinutes} minutes old, exceeding the ${policy.ageDegradedMinutes}-minute review SLO.`,
    });
  } else if (oldestAgeMinutes !== null && oldestAgeMinutes >= policy.ageWarningMinutes) {
    issues.push({
      severity: 'warning',
      code: 'MODERATION_QUEUE_AGE_WARNING',
      message: `The oldest open moderation report is ${oldestAgeMinutes} minutes old; review it before the ${policy.ageDegradedMinutes}-minute SLO.`,
    });
  }

  if (totalOpenCount >= policy.countDegraded) {
    issues.push({
      severity: 'degraded',
      code: 'MODERATION_QUEUE_VOLUME_OVERLOAD',
      message: `${totalOpenCount} moderation reports are open, exceeding the queue limit of ${policy.countDegraded}.`,
    });
  } else if (totalOpenCount >= policy.countWarning) {
    issues.push({
      severity: 'warning',
      code: 'MODERATION_QUEUE_VOLUME_WARNING',
      message: `${totalOpenCount} moderation reports are open; investigate queue capacity before it reaches ${policy.countDegraded}.`,
    });
  }

  return {
    status: maxStatus(['ok', ...issues.map((issue) => issue.severity)]),
    checkedAt: now.toISOString(),
    policy,
    queue: {
      postReportCount: normalizedPostReportCount,
      subjectReportCount: normalizedSubjectReportCount,
      totalOpenCount,
      oldestCreatedAt,
      oldestAgeMinutes,
    },
    issues,
  };
}

function queryError(operation: string, error: unknown): Error {
  const message = error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : 'Unknown database error';
  return new Error(`${operation}: ${message}`);
}

export async function collectBackendModerationHealth(
  client: SupabaseClient,
  now = new Date(),
): Promise<BackendModerationHealth> {
  const [postReports, subjectReports] = await Promise.all([
    client
      .from('post_reports')
      .select('created_at', { count: 'exact' })
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(1),
    client
      .from('moderation_reports')
      .select('created_at', { count: 'exact' })
      .in('status', ['open', 'reviewing'])
      .order('created_at', { ascending: true })
      .limit(1),
  ]);

  if (postReports.error) {
    throw queryError('Failed to inspect the post moderation queue', postReports.error);
  }
  if (subjectReports.error) {
    throw queryError('Failed to inspect the subject moderation queue', subjectReports.error);
  }

  const oldestPostReport = ((postReports.data ?? []) as ModerationQueueRow[])[0];
  const oldestSubjectReport = ((subjectReports.data ?? []) as ModerationQueueRow[])[0];

  return buildBackendModerationHealth({
    postReportCount: postReports.count ?? 0,
    subjectReportCount: subjectReports.count ?? 0,
    oldestPostReportCreatedAt: oldestPostReport?.created_at ?? null,
    oldestSubjectReportCreatedAt: oldestSubjectReport?.created_at ?? null,
    now,
  });
}
