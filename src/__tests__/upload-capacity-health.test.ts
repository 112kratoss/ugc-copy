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

/**
 * Incident #78: the backend alert watchdog went to 503 at 2026-08-25 08:20 UTC
 * on a single abandoned upload staged two days earlier, and could not recover.
 *
 * Reservation 43212af4 was staged at 06:20 on 08-23, so its signed URL expired
 * at 08:20 that day, and `reclaim_after` deferred it to 06:20 on 08-25 --
 * 48 hours past finalization. Health aged it from *expiry*, so two hours after
 * it first became eligible it read as 48 hours stale and degraded the whole
 * ops endpoint. It was also never-consumed, the exact class
 * MEDIA_UPLOAD_RECLAIM_ABANDONED withholds from the sweep, so no run of the
 * daily job could ever have lowered the number.
 */
const INCIDENT_78 = {
  stagedAt: '2026-08-23T06:20:15.653Z',
  /** When the signed upload URL lapsed: the clock health used to read. */
  expiresAt: '2026-08-23T08:20:15.653Z',
  /** When the sweep was first allowed to touch it: the clock health must read. */
  eligibleAt: '2026-08-25T06:20:18.504Z',
  /** The probe that first reported degraded. */
  firstFailingProbeAt: '2026-08-25T11:15:11.013Z',
};

/**
 * The env flag alone never enables abandoned reclaim: the code-controlled
 * compatibility floor is still 0.0.1, below the 0.0.5 that proves clients can
 * recover from a reclaimed draft. Tests that need the enabled path have to
 * raise both, which is the same pair isAbandonedIntentReclaimEnabled takes.
 */
const ENABLED_RECLAIM_POLICY = {
  environment: { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' },
  minimumAppVersion: '0.0.5',
};

/**
 * Stands in for the migrated RPC: it honours `p_include_abandoned` and returns
 * the instant a row became actionable rather than the instant it expired.
 */
function reclaimGatedClient(reservations: Array<{
  expiresAt: string;
  eligibleAt: string;
  consumed: boolean;
}>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'get_upload_reclaim_health') {
          calls.push(args);
          const includeAbandoned = args.p_include_abandoned === true;
          const eligible = reservations.filter(
            (row) => Date.parse(row.eligibleAt) <= Date.parse(String(args.p_now)),
          );
          const actionable = eligible.filter((row) => includeAbandoned || row.consumed);
          const withheld = includeAbandoned
            ? []
            : eligible.filter((row) => !row.consumed);
          const oldestActionableAt = actionable
            .map((row) => row.eligibleAt)
            .sort()[0] ?? null;
          return {
            data: [{
              actionable_rows: String(actionable.length),
              actionable_rows_capped: false,
              deferred_rows: String(reservations.length - eligible.length),
              deferred_rows_capped: false,
              withheld_rows: String(withheld.length),
              withheld_rows_capped: false,
              oldest_actionable_at: oldestActionableAt,
              oldest_deferred_at: null,
              outstanding_bytes: '3895587',
              tombstone_rows: '3',
            }],
            error: null,
          };
        }
        return {
          data: {
            status: 'ok',
            recordedGlobalBytes: 3895587,
            calculatedGlobalBytes: 3895587,
            userDriftCount: 0,
          },
          error: null,
        };
      },
    },
  };
}

describe('upload reclaim backlog SLO (incident #78)', () => {
  it('withholds never-consumed rows from the backlog while the rollout gate is closed', async () => {
    const { calls, client } = reclaimGatedClient([
      { ...INCIDENT_78, consumed: false },
    ]);

    const report = await collectUploadCapacityHealth(
      client as never,
      new Date(INCIDENT_78.firstFailingProbeAt),
      { environment: {} },
    );

    // The gate is what the sweep asks; health has to ask the same question.
    expect(calls[0]?.p_include_abandoned).toBe(false);
    expect(report.abandonedReclaimEnabled).toBe(false);
    expect(report.actionableRows).toBe(0);
    expect(report.withheldRows).toBe(1);
    // Visible, but never a page: no run of the job could clear it.
    expect(report.status).toBe('warning');
    expect(report.issues.map((issue) => issue.code)).toEqual(['UPLOAD_RECLAIM_WITHHELD']);
  });

  it('ages an actionable row from when it became eligible, not from when it expired', async () => {
    const { calls, client } = reclaimGatedClient([
      { ...INCIDENT_78, consumed: true },
    ]);

    const report = await collectUploadCapacityHealth(
      client as never,
      new Date(INCIDENT_78.firstFailingProbeAt),
      ENABLED_RECLAIM_POLICY,
    );

    expect(calls[0]?.p_include_abandoned).toBe(true);
    expect(report.actionableRows).toBe(1);
    expect(report.oldestActionableAt).toBe(INCIDENT_78.eligibleAt);
    // ~4.9 hours eligible. Aged from expiresAt it would be 50.9 and degraded,
    // which is what took the watchdog down before the daily sweep could run.
    expect(
      Date.parse(INCIDENT_78.firstFailingProbeAt) - Date.parse(INCIDENT_78.expiresAt),
    ).toBeGreaterThan(48 * 60 * 60 * 1000);
    expect(report.status).toBe('ok');
    expect(report.issues).toEqual([]);
  });

  it('still degrades when eligible work really has gone two days unreclaimed', async () => {
    const { client } = reclaimGatedClient([
      { ...INCIDENT_78, consumed: true },
    ]);

    const report = await collectUploadCapacityHealth(
      client as never,
      new Date('2026-08-27T07:00:00.000Z'),
      ENABLED_RECLAIM_POLICY,
    );

    expect(report.status).toBe('degraded');
    expect(report.issues.map((issue) => issue.code)).toEqual(['UPLOAD_RECLAIM_BACKLOG']);
  });

  it('leaves the deferred half alone until its reclaim_after passes', async () => {
    const { client } = reclaimGatedClient([
      { ...INCIDENT_78, consumed: true },
    ]);

    const report = await collectUploadCapacityHealth(
      client as never,
      // Between expiry and eligibility: 46 hours past the clock health used to
      // read, and not yet reclaimable at all.
      new Date('2026-08-25T05:00:00.000Z'),
      ENABLED_RECLAIM_POLICY,
    );

    expect(report.actionableRows).toBe(0);
    expect(report.deferredRows).toBe(1);
    expect(report.status).toBe('ok');
  });
});
