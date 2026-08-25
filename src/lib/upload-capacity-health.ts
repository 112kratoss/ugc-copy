import type { SupabaseClient } from '@supabase/supabase-js';

import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';

export type UploadCapacityHealthStatus = 'ok' | 'warning' | 'degraded';

export type UploadCapacityHealthIssue = {
  severity: Exclude<UploadCapacityHealthStatus, 'ok'>;
  code:
    | 'UPLOAD_RECLAIM_BACKLOG'
    | 'UPLOAD_RECLAIM_WITHHELD'
    | 'UPLOAD_ADMISSION_COUNTER_DRIFT';
  message: string;
};

export type UploadCapacityHealth = {
  status: UploadCapacityHealthStatus;
  actionableRows: number;
  actionableRowsCapped: boolean;
  deferredRows: number;
  deferredRowsCapped: boolean;
  /**
   * Rows the sweep is forbidden to touch while the abandoned-reclaim rollout
   * gate is off. Reported so the hold stays visible, and kept out of
   * `actionableRows` so it cannot breach an SLO no run of the job could meet.
   */
  withheldRows: number;
  withheldRowsCapped: boolean;
  abandonedReclaimEnabled: boolean;
  oldestActionableAt: string | null;
  oldestDeferredAt: string | null;
  outstandingBytes: number;
  tombstoneRows: number;
  counterStatus: 'ok' | 'drift';
  recordedGlobalBytes: number;
  calculatedGlobalBytes: number;
  userDriftCount: number;
  issues: UploadCapacityHealthIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function dateValue(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function maxStatus(issues: UploadCapacityHealthIssue[]): UploadCapacityHealthStatus {
  if (issues.some((issue) => issue.severity === 'degraded')) return 'degraded';
  return issues.length > 0 ? 'warning' : 'ok';
}

/**
 * `oldestActionableAt` is the instant a row became *eligible* for reclaim, not
 * the instant its signed upload URL expired. The two are ~46 hours apart for a
 * never-consumed reservation, because `reclaim_after` defers it until
 * `RECLAIM_AFTER_HOURS` past finalization -- so ageing from expiry reported
 * freshly-eligible work as two days stale. See the 20260825120000 migration.
 */
export async function collectUploadCapacityHealth(
  client: Pick<SupabaseClient, 'rpc'>,
  now = new Date(),
  // Both knobs, in the same shape as isAbandonedIntentReclaimEnabled: the env
  // flag is never sufficient on its own, because the code-controlled
  // compatibility floor still has to exclude clients that cannot recover from
  // a reclaimed draft.
  options: {
    environment?: Record<string, string | undefined>;
    minimumAppVersion?: string;
  } = {},
): Promise<UploadCapacityHealth> {
  // The sweep withholds never-consumed rows until this gate is effective, so
  // health has to ask the same question the sweep asks. Measuring a queue the
  // job may not drain turns a deliberate rollout hold into a permanent breach.
  const abandonedReclaimEnabled = getMediaUploadReclaimPolicy({
    environment: options.environment,
    minimumAppVersion: options.minimumAppVersion,
  }).effectiveEnabled;
  const [reclaimResult, counterResult] = await Promise.all([
    client.rpc('get_upload_reclaim_health', {
      p_now: now.toISOString(),
      p_include_abandoned: abandonedReclaimEnabled,
    }),
    client.rpc('reconcile_upload_byte_admission_counters', { p_repair: false }),
  ]);
  if (reclaimResult.error) throw reclaimResult.error;
  if (counterResult.error) throw counterResult.error;

  const reclaim = Array.isArray(reclaimResult.data) && isRecord(reclaimResult.data[0])
    ? reclaimResult.data[0]
    : null;
  const counters = isRecord(counterResult.data) ? counterResult.data : null;
  if (!reclaim || !counters) throw new Error('Upload capacity health RPC returned an invalid payload.');

  const actionableRows = numberValue(reclaim.actionable_rows);
  const actionableRowsCapped = booleanValue(reclaim.actionable_rows_capped);
  const oldestActionableAt = dateValue(reclaim.oldest_actionable_at);
  const actionableAgeMs = oldestActionableAt
    ? Math.max(0, now.getTime() - Date.parse(oldestActionableAt))
    : 0;
  const counterStatus = counters.status === 'ok' ? 'ok' : 'drift';
  const withheldRows = numberValue(reclaim.withheld_rows);
  const withheldRowsCapped = booleanValue(reclaim.withheld_rows_capped);
  const issues: UploadCapacityHealthIssue[] = [];

  if (
    actionableRowsCapped
    || actionableRows >= 20_000
    || actionableAgeMs >= 48 * 60 * 60 * 1000
  ) {
    issues.push({
      severity: 'degraded',
      code: 'UPLOAD_RECLAIM_BACKLOG',
      message: `Upload reclaim has ${actionableRowsCapped ? 'at least ' : ''}${actionableRows} actionable rows; the oldest is ${oldestActionableAt ?? 'unknown'}.`,
    });
  } else if (actionableRows >= 5_000 || actionableAgeMs >= 24 * 60 * 60 * 1000) {
    issues.push({
      severity: 'warning',
      code: 'UPLOAD_RECLAIM_BACKLOG',
      message: `Upload reclaim has ${actionableRows} actionable rows; the oldest is ${oldestActionableAt ?? 'unknown'}.`,
    });
  }

  // A warning, never degraded: the operator chose this hold, and no run of the
  // sweep can clear it. It still costs storage, so it is reported rather than
  // dropped -- the number is the cost of leaving the gate closed.
  if (withheldRows > 0) {
    issues.push({
      severity: 'warning',
      code: 'UPLOAD_RECLAIM_WITHHELD',
      message: `${withheldRowsCapped ? 'At least ' : ''}${withheldRows} staged upload(s) are eligible for reclaim but withheld because MEDIA_UPLOAD_RECLAIM_ABANDONED is not effective; the sweep cannot collect them.`,
    });
  }

  if (counterStatus === 'drift') {
    issues.push({
      severity: 'degraded',
      code: 'UPLOAD_ADMISSION_COUNTER_DRIFT',
      message: `Upload admission counters disagree with authoritative reservations for ${numberValue(counters.userDriftCount)} users.`,
    });
  }

  return {
    status: maxStatus(issues),
    actionableRows,
    actionableRowsCapped,
    deferredRows: numberValue(reclaim.deferred_rows),
    deferredRowsCapped: booleanValue(reclaim.deferred_rows_capped),
    withheldRows,
    withheldRowsCapped,
    abandonedReclaimEnabled,
    oldestActionableAt,
    oldestDeferredAt: dateValue(reclaim.oldest_deferred_at),
    outstandingBytes: numberValue(reclaim.outstanding_bytes),
    tombstoneRows: numberValue(reclaim.tombstone_rows),
    counterStatus,
    recordedGlobalBytes: numberValue(counters.recordedGlobalBytes),
    calculatedGlobalBytes: numberValue(counters.calculatedGlobalBytes),
    userDriftCount: numberValue(counters.userDriftCount),
    issues,
  };
}
