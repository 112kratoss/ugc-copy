import type { SupabaseClient } from '@supabase/supabase-js';

export type UploadCapacityHealthStatus = 'ok' | 'warning' | 'degraded';

export type UploadCapacityHealthIssue = {
  severity: Exclude<UploadCapacityHealthStatus, 'ok'>;
  code: 'UPLOAD_RECLAIM_BACKLOG' | 'UPLOAD_ADMISSION_COUNTER_DRIFT';
  message: string;
};

export type UploadCapacityHealth = {
  status: UploadCapacityHealthStatus;
  actionableRows: number;
  actionableRowsCapped: boolean;
  deferredRows: number;
  deferredRowsCapped: boolean;
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

export async function collectUploadCapacityHealth(
  client: Pick<SupabaseClient, 'rpc'>,
  now = new Date(),
): Promise<UploadCapacityHealth> {
  const [reclaimResult, counterResult] = await Promise.all([
    client.rpc('get_upload_reclaim_health', { p_now: now.toISOString() }),
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
