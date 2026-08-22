import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { pruneOperationalBackendData } from '@/lib/operational-data-retention';

const reclaimExpiredUploadReservationsMock = vi.hoisted(() => vi.fn(async () => ({
  scanned: 0,
  handled: 0,
  objectsDeleted: 0,
  absentObjectsReleased: 0,
  failed: 0,
  bytesDeleted: 0,
  scanLimitReached: false,
  timeBudgetReached: false,
  oldestCandidateExpiresAt: null,
})));

vi.mock('@/lib/upload-finalization', () => ({
  reclaimExpiredUploadReservations: reclaimExpiredUploadReservationsMock,
}));

type RpcCall = { fn: string; args: Record<string, unknown> };

function createClient(result: {
  data?: unknown;
  error?: unknown;
  shareEvents?: { data?: unknown; error?: unknown };
  profileShareEvents?: { data?: unknown; error?: unknown };
  freeUnlockOrders?: { data?: unknown; error?: unknown };
}) {
  const calls: RpcCall[] = [];
  return {
    calls,
    // `pruneOperationalBackendData` already narrows its parameter to
    // Pick<SupabaseClient, 'rpc'>, but Supabase's real `rpc` carries generic
    // overloads a hand-written stub cannot reproduce. Widen once here.
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === 'prune_post_share_events') {
          return {
            data: result.shareEvents?.data ?? 0,
            error: result.shareEvents?.error ?? null,
          };
        }
        if (fn === 'prune_profile_share_events') {
          return {
            data: result.profileShareEvents?.data ?? 0,
            error: result.profileShareEvents?.error ?? null,
          };
        }
        if (fn === 'prune_abandoned_free_unlock_orders') {
          return {
            data: result.freeUnlockOrders?.data ?? 0,
            error: result.freeUnlockOrders?.error ?? null,
          };
        }
        if (fn === 'prune_account_merge_tickets') {
          return { data: 0, error: null };
        }
        return { data: result.data ?? null, error: result.error ?? null };
      },
    } as unknown as SupabaseClient,
  };
}

describe('operational data retention', () => {
  beforeEach(() => {
    reclaimExpiredUploadReservationsMock.mockClear();
  });

  it('calls the bounded retention RPC and maps its summary', async () => {
    const { client, calls } = createClient({
      data: {
        job_runs_deleted: 4200,
        rate_limits_deleted: 12,
        completion_jobs_deleted: 3,
        provider_events_deleted: 90,
        provider_checks_deleted: 7,
        total_deleted: 4312,
        batch_limit_reached: false,
        pruned_at: '2026-07-25T00:50:00.000Z',
      },
      shareEvents: { data: 18 },
      profileShareEvents: { data: 6 },
      freeUnlockOrders: { data: 2 },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(calls[0].fn).toBe('prune_operational_backend_data');
    expect(summary).toEqual({
      jobRunsDeleted: 4200,
      rateLimitsDeleted: 12,
      completionJobsDeleted: 3,
      providerEventsDeleted: 90,
      providerChecksDeleted: 7,
      totalDeleted: 4312,
      batchLimitReached: false,
      shareEventsDeleted: 18,
      profileShareEventsDeleted: 6,
      abandonedFreeUnlockOrdersDeleted: 2,
      accountMergeTicketsDeleted: 0,
      uploadByteReservationsDeleted: 0,
      expiredUploadReservationsScanned: 0,
      expiredUploadReservationsHandled: 0,
      expiredUploadObjectsDeleted: 0,
      expiredUploadReservationFailures: 0,
      uploadReclaimScanLimitReached: false,
      uploadReclaimTimeBudgetReached: false,
      oldestExpiredUploadCandidateAt: null,
    });
  });

  it('sweeps the tables the main retention function misses', async () => {
    // Both share ledgers are append-only telemetry with no retention policy of
    // their own, and a retried free unlock leaves a synthetic $0 order behind.
    const { client, calls } = createClient({
      data: { total_deleted: 0 },
      shareEvents: { data: 40 },
      profileShareEvents: { data: 11 },
      freeUnlockOrders: { data: 5 },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(calls.map((call) => call.fn)).toEqual([
      'prune_operational_backend_data',
      'prune_post_share_events',
      'prune_profile_share_events',
      'prune_abandoned_free_unlock_orders',
      'prune_account_merge_tickets',
      'prune_upload_byte_reservations',
    ]);
    expect(summary.shareEventsDeleted).toBe(40);
    expect(summary.profileShareEventsDeleted).toBe(11);
    expect(summary.abandonedFreeUnlockOrdersDeleted).toBe(5);
    expect(reclaimExpiredUploadReservationsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the main sweep result when a supplementary prune fails', async () => {
    // These are best-effort: a missing function on an older database must not
    // fail the retention run that did succeed.
    const { client } = createClient({
      data: { total_deleted: 12, job_runs_deleted: 12 },
      shareEvents: { error: { message: 'function does not exist' } },
      profileShareEvents: { error: { message: 'function does not exist' } },
      freeUnlockOrders: { error: { message: 'function does not exist' } },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.jobRunsDeleted).toBe(12);
    expect(summary.shareEventsDeleted).toBe(0);
    expect(summary.profileShareEventsDeleted).toBe(0);
    expect(summary.abandonedFreeUnlockOrdersDeleted).toBe(0);
  });

  it('passes an explicit sweep time so the job run and the deletes agree', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client, { now: new Date('2026-07-25T00:50:00.000Z') });

    expect(calls[0].args.p_now).toBe('2026-07-25T00:50:00.000Z');
  });

  it('omits optional arguments so the database defaults stay authoritative', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client);

    expect(calls[0].args).not.toHaveProperty('p_now');
    expect(calls[0].args).not.toHaveProperty('p_max_deletes_per_table');
  });

  it('forwards an explicit batch cap when one is given', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client, { maxDeletesPerTable: 100 });

    expect(calls[0].args.p_max_deletes_per_table).toBe(100);
  });

  it('surfaces a backlog so the next scheduled run is known to have work', async () => {
    const { client } = createClient({
      data: { job_runs_deleted: 5000, total_deleted: 5000, batch_limit_reached: true },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.batchLimitReached).toBe(true);
  });

  it('treats a missing or malformed count as zero rather than NaN', async () => {
    const { client } = createClient({ data: { job_runs_deleted: 'lots' } });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.jobRunsDeleted).toBe(0);
    expect(summary.totalDeleted).toBe(0);
  });

  it('throws when the RPC fails so the job records a failure instead of a silent no-op', async () => {
    const { client } = createClient({ error: new Error('permission denied') });

    await expect(pruneOperationalBackendData(client)).rejects.toThrow('permission denied');
  });
});
