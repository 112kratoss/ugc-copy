import { describe, expect, it } from 'vitest';

import { collectUploadCapacityHealth } from '@/lib/upload-capacity-health';

function clientWith({
  actionableRows = 0,
  actionableRowsCapped = false,
  oldestActionableAt = null as string | null,
  counterStatus = 'ok',
  userDriftCount = 0,
} = {}) {
  return {
    rpc: async (fn: string) => {
      if (fn === 'get_upload_reclaim_health') {
        return {
          data: [{
            actionable_rows: String(actionableRows),
            actionable_rows_capped: actionableRowsCapped,
            deferred_rows: '12',
            deferred_rows_capped: false,
            oldest_actionable_at: oldestActionableAt,
            oldest_deferred_at: '2026-08-23T00:00:00.000Z',
            outstanding_bytes: '2048',
            tombstone_rows: '42',
          }],
          error: null,
        };
      }
      return {
        data: {
          status: counterStatus,
          recordedGlobalBytes: 2048,
          calculatedGlobalBytes: counterStatus === 'ok' ? 2048 : 4096,
          userDriftCount,
        },
        error: null,
      };
    },
  };
}

describe('upload capacity health', () => {
  it('reports healthy bounded admission and reclaim state', async () => {
    await expect(collectUploadCapacityHealth(
      clientWith() as never,
      new Date('2026-08-22T00:00:00.000Z'),
    )).resolves.toMatchObject({
      status: 'ok',
      actionableRows: 0,
      actionableRowsCapped: false,
      deferredRows: 12,
      deferredRowsCapped: false,
      outstandingBytes: 2048,
      tombstoneRows: 42,
      counterStatus: 'ok',
      issues: [],
    });
  });

  it('degrades when the bounded health sample reaches its cap', async () => {
    const report = await collectUploadCapacityHealth(
      clientWith({ actionableRows: 20_000, actionableRowsCapped: true }) as never,
    );

    expect(report.status).toBe('degraded');
    expect(report.issues[0]?.message).toContain('at least 20000');
  });

  it('degrades on old reclaim work or counter drift', async () => {
    const report = await collectUploadCapacityHealth(
      clientWith({
        actionableRows: 10,
        oldestActionableAt: '2026-08-19T00:00:00.000Z',
        counterStatus: 'drift',
        userDriftCount: 3,
      }) as never,
      new Date('2026-08-22T00:00:00.000Z'),
    );

    expect(report.status).toBe('degraded');
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'UPLOAD_RECLAIM_BACKLOG',
      'UPLOAD_ADMISSION_COUNTER_DRIFT',
    ]);
  });
});
