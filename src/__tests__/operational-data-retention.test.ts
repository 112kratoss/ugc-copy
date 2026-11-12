import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { GuestAccountLinkedError } from '@/lib/account-deletion-service';
import {
  deleteIdleGuestIdentities,
  EXPIRED_UPLOAD_RESERVATION_RECLAIM_LIMIT,
  IDLE_CONTENT_GUEST_RETIREMENT_BATCH_LIMIT,
  IDLE_CONTENT_GUEST_RETIREMENT_LAST_START_MS,
  IDLE_GUEST_RETENTION_BATCH_LIMIT,
  OPERATIONAL_RETENTION_MAX_BATCHES,
  pruneOperationalBackendData,
  retireIdleGuestsWithContent,
} from '@/lib/operational-data-retention';

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
  referralRiskSignals?: { data?: unknown; error?: unknown };
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
        if (fn === 'prune_referral_risk_signals') {
          return {
            data: result.referralRiskSignals?.data ?? 0,
            error: result.referralRiskSignals?.error ?? null,
          };
        }
        if (fn === 'list_idle_guest_identities' || fn === 'list_idle_guest_identities_with_content') {
          return { data: [], error: null };
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
      referralRiskSignals: { data: 5 },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(calls[0].fn).toBe('prune_operational_backend_data');
    expect(summary).toEqual({
      supplementaryPruneFailures: [],
      jobRunsDeleted: 4200,
      rateLimitsDeleted: 12,
      completionJobsDeleted: 3,
      providerEventsDeleted: 90,
      providerChecksDeleted: 7,
      playbackDaysRolledUp: 0,
      playbackMetricsDeleted: 0,
      onboardingEventsDeleted: 0,
      aiUsagePayloadsCleared: 0,
      unreadNotificationsDeleted: 0,
      expiredJobLocksDeleted: 0,
      searchQueryEventsDeleted: 0,
      searchVisitorDayKeysDeleted: 0,
      totalDeleted: 4312,
      pruneBatches: 1,
      batchLimitReached: false,
      pruneTimeBudgetReached: false,
      shareEventsDeleted: 18,
      profileShareEventsDeleted: 6,
      abandonedFreeUnlockOrdersDeleted: 2,
      accountMergeTicketsDeleted: 0,
      // The Privacy Policy's 90 days for referral visit signals (20261110070035).
      referralRiskSignalsCleared: 5,
      uploadByteReservationsDeleted: 0,
      supplementaryBatchLimitReached: false,
      expiredUploadReservationsScanned: 0,
      expiredUploadReservationsHandled: 0,
      expiredUploadObjectsDeleted: 0,
      expiredUploadReservationFailures: 0,
      uploadReclaimScanLimitReached: false,
      uploadReclaimTimeBudgetReached: false,
      oldestExpiredUploadCandidateAt: null,
      idleGuestCandidates: 0,
      idleGuestsDeleted: 0,
      idleGuestsSkipped: 0,
      idleGuestDeletionFailures: 0,
      idleGuestBatchLimitReached: false,
      idleGuestTimeBudgetReached: false,
      contentGuestCandidates: 0,
      contentGuestsRetired: 0,
      contentGuestsSkipped: 0,
      contentGuestRetirementFailures: 0,
      contentGuestBatchLimitReached: false,
      contentGuestTimeBudgetReached: false,
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
      'prune_referral_risk_signals',
      'prune_upload_byte_reservations',
      'list_idle_guest_identities',
      'list_idle_guest_identities_with_content',
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

// D5 (2026-10-15): the run also deletes guest identities nobody has used for
// 90 days and that hold nothing. Who qualifies is the database's decision
// (list_idle_guest_identities, pinned by guest_data_retention.test.sql); this
// is the part that acts on it.
describe('idle-guest retention', () => {
  function guestId(index: number) {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  }

  function idleGuestRow(userId: string) {
    return { user_id: userId, created_at: '2026-01-01T00:00:00.000Z', last_active_at: '2026-01-01T00:00:00.000Z' };
  }

  function guestRetentionClient(options: {
    listed?: string[];
    listResult?: { data: unknown; error: unknown };
    stillIdle?: (userId: string) => boolean;
    recheckError?: (userId: string) => unknown;
    deleteError?: (userId: string) => unknown;
    onDelete?: (userId: string) => void;
  } = {}) {
    const order: string[] = [];
    const listCalls: Array<Record<string, unknown>> = [];
    const deleteUser = vi.fn(async (userId: string) => {
      order.push(`delete:${userId}`);
      options.onDelete?.(userId);
      return { data: null, error: options.deleteError?.(userId) ?? null };
    });
    const client = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === 'list_idle_guest_identities_with_content') return { data: [], error: null };
        if (fn !== 'list_idle_guest_identities') {
          return { data: fn === 'prune_operational_backend_data' ? { total_deleted: 0 } : 0, error: null };
        }
        listCalls.push(args);
        if (typeof args.p_user_id === 'string') {
          order.push(`recheck:${args.p_user_id}`);
          const recheckError = options.recheckError?.(args.p_user_id);
          if (recheckError) return { data: null, error: recheckError };
          const idle = options.stillIdle?.(args.p_user_id) ?? true;
          return { data: idle ? [idleGuestRow(args.p_user_id)] : [], error: null };
        }
        order.push('list');
        if (options.listResult) return options.listResult;
        // The database answers at most p_limit rows.
        return {
          data: (options.listed ?? []).slice(0, Number(args.p_limit)).map(idleGuestRow),
          error: null,
        };
      }),
      auth: { admin: { deleteUser } },
    };
    return { client: client as unknown as SupabaseClient, deleteUser, listCalls, order };
  }

  beforeEach(() => {
    reclaimExpiredUploadReservationsMock.mockClear();
  });

  it('deletes only the guests the database names, asking about each again right before', async () => {
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client, deleteUser, order } = guestRetentionClient({ listed: guests });

    const summary = await pruneOperationalBackendData(client);

    expect(order).toEqual([
      'list',
      `recheck:${guests[0]}`, `delete:${guests[0]}`,
      `recheck:${guests[1]}`, `delete:${guests[1]}`,
      `recheck:${guests[2]}`, `delete:${guests[2]}`,
    ]);
    expect(deleteUser.mock.calls.map(([userId]) => userId)).toEqual(guests);
    expect(summary).toMatchObject({
      idleGuestCandidates: 3,
      idleGuestsDeleted: 3,
      idleGuestsSkipped: 0,
      idleGuestDeletionFailures: 0,
      idleGuestBatchLimitReached: false,
      idleGuestTimeBudgetReached: false,
      supplementaryPruneFailures: [],
    });
  });

  it('leaves alone a guest that came back while the run was under way', async () => {
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client, deleteUser } = guestRetentionClient({
      listed: guests,
      stillIdle: (userId) => userId !== guests[1],
    });

    const summary = await pruneOperationalBackendData(client);

    expect(deleteUser.mock.calls.map(([userId]) => userId)).toEqual([guests[0], guests[2]]);
    expect(summary).toMatchObject({ idleGuestsDeleted: 2, idleGuestsSkipped: 1, idleGuestDeletionFailures: 0 });
  });

  it('stays bounded: asks for one batch, deletes no more, and says a backlog remains', async () => {
    const backlog = Array.from({ length: IDLE_GUEST_RETENTION_BATCH_LIMIT + 50 }, (_, index) => guestId(index + 1));
    const { client, deleteUser, listCalls } = guestRetentionClient({ listed: backlog });

    const summary = await pruneOperationalBackendData(client);

    expect(IDLE_GUEST_RETENTION_BATCH_LIMIT).toBe(100);
    expect(listCalls[0]).toEqual({ p_limit: 100 });
    expect(deleteUser).toHaveBeenCalledTimes(100);
    expect(summary).toMatchObject({
      idleGuestCandidates: 100,
      idleGuestsDeleted: 100,
      idleGuestBatchLimitReached: true,
    });

    const small = guestRetentionClient({ listed: backlog });
    const smallSummary = await pruneOperationalBackendData(small.client, { idleGuestDeletionLimit: 2 });
    expect(small.listCalls[0]).toEqual({ p_limit: 2 });
    expect(small.deleteUser).toHaveBeenCalledTimes(2);
    expect(smallSummary).toMatchObject({ idleGuestsDeleted: 2, idleGuestBatchLimitReached: true });
  });

  it('never acts on more guests than it asked for', async () => {
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client, deleteUser } = guestRetentionClient({
      listResult: { data: guests.map(idleGuestRow), error: null },
    });

    const summary = await deleteIdleGuestIdentities(client, { limit: 2 });

    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ idleGuestCandidates: 2, idleGuestBatchLimitReached: true });
  });

  it('passes the sweep time to the database, so the list and every re-check agree', async () => {
    const guests = [guestId(1)];
    const { client, listCalls } = guestRetentionClient({ listed: guests });

    await pruneOperationalBackendData(client, { now: new Date('2026-10-16T00:50:00.000Z') });

    expect(listCalls).toEqual([
      { p_now: '2026-10-16T00:50:00.000Z', p_limit: 100 },
      { p_now: '2026-10-16T00:50:00.000Z', p_limit: 1, p_user_id: guests[0] },
    ]);
  });

  it('stops when its minute is up, leaving the rest for the next run', async () => {
    let clockMs = 0;
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client, deleteUser } = guestRetentionClient({
      listed: guests,
      onDelete: () => {
        clockMs += 30_000;
      },
    });

    const summary = await pruneOperationalBackendData(client, { clock: () => clockMs });

    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      idleGuestCandidates: 3,
      idleGuestsDeleted: 2,
      idleGuestTimeBudgetReached: true,
    });
  });

  it('yields to the rest of the run: after a long upload reclaim it does only what time is left', async () => {
    let clockMs = 0;
    reclaimExpiredUploadReservationsMock.mockImplementationOnce(async () => {
      clockMs += 265_000;
      return {
        scanned: 0, handled: 0, objectsDeleted: 0, absentObjectsReleased: 0, failed: 0,
        bytesDeleted: 0, scanLimitReached: false, timeBudgetReached: true, oldestCandidateExpiresAt: null,
      };
    });
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client, deleteUser } = guestRetentionClient({
      listed: guests,
      onDelete: () => {
        clockMs += 10_000;
      },
    });

    const summary = await pruneOperationalBackendData(client, { clock: () => clockMs });

    // 270 s into the 300 s run nothing new starts.
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ idleGuestsDeleted: 1, idleGuestTimeBudgetReached: true });
  });

  it('records a failed list and still completes the run', async () => {
    const { client, deleteUser } = guestRetentionClient({
      listResult: { data: null, error: { message: 'function does not exist' } },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(deleteUser).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      supplementaryPruneFailures: ['list_idle_guest_identities'],
      idleGuestCandidates: 0,
      idleGuestsDeleted: 0,
    });
  });

  it('treats an answer of the wrong shape as a failure, never as guests to delete', async () => {
    for (const data of [3, { user_id: guestId(1) }, [{ user_id: 'not-a-uuid' }], [null]]) {
      const { client, deleteUser } = guestRetentionClient({ listResult: { data, error: null } });

      const summary = await pruneOperationalBackendData(client);

      expect(deleteUser).not.toHaveBeenCalled();
      expect(summary.supplementaryPruneFailures).toEqual(['list_idle_guest_identities']);
    }
  });

  it('counts each failed deletion, names it once, and stops after three in a row', async () => {
    const guests = [guestId(1), guestId(2), guestId(3), guestId(4), guestId(5)];
    const { client, deleteUser } = guestRetentionClient({
      listed: guests,
      deleteError: () => ({ status: 500, message: 'Auth unavailable' }),
    });

    const summary = await pruneOperationalBackendData(client);

    expect(deleteUser).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      idleGuestCandidates: 5,
      idleGuestsDeleted: 0,
      idleGuestDeletionFailures: 3,
      supplementaryPruneFailures: ['delete_idle_guest_identity'],
    });
  });

  it('counts a guest that is already gone as left alone, not as a failure', async () => {
    const guests = [guestId(1), guestId(2)];
    const { client } = guestRetentionClient({
      listed: guests,
      deleteError: (userId) => (userId === guests[0] ? { status: 404, message: 'User not found' } : null),
    });

    const summary = await pruneOperationalBackendData(client);

    expect(summary).toMatchObject({
      idleGuestsDeleted: 1,
      idleGuestsSkipped: 1,
      idleGuestDeletionFailures: 0,
      supplementaryPruneFailures: [],
    });
  });

  it('records a failed re-check as a failure and deletes nothing for that guest', async () => {
    const guests = [guestId(1), guestId(2)];
    const { client, deleteUser } = guestRetentionClient({
      listed: guests,
      recheckError: (userId) => (userId === guests[0] ? { message: 'statement timeout' } : null),
    });

    const summary = await pruneOperationalBackendData(client);

    expect(deleteUser.mock.calls.map(([userId]) => userId)).toEqual([guests[1]]);
    expect(summary).toMatchObject({
      idleGuestsDeleted: 1,
      idleGuestDeletionFailures: 1,
      supplementaryPruneFailures: ['delete_idle_guest_identity'],
    });
  });
});

// Usage audit (2026-11-04): each prune deletes one bounded batch per call, so
// the run calls it again while a batch comes back full, until the backlog is
// gone or its step's time is up.
describe('batches until the backlog is gone', () => {
  type Answer = { data?: unknown; error?: unknown } | (() => never);

  function batchClient(answers: Record<string, Answer[]>) {
    const calls: RpcCall[] = [];
    const client = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push({ fn, args });
        if (fn.startsWith('list_idle_guest_identities')) return { data: [], error: null };
        const queue = answers[fn];
        const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
        if (typeof next === 'function') return next();
        return { data: next?.data ?? (fn === 'prune_operational_backend_data' ? { total_deleted: 0 } : 0), error: next?.error ?? null };
      }),
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  const full = (extra: Record<string, unknown> = {}) => ({
    data: { job_runs_deleted: 5000, rate_limits_deleted: 10, total_deleted: 5010, batch_limit_reached: true, ...extra },
  });
  const last = { data: { job_runs_deleted: 1200, playback_metrics_deleted: 4, total_deleted: 1204, batch_limit_reached: false } };

  beforeEach(() => {
    reclaimExpiredUploadReservationsMock.mockClear();
  });

  it('calls the prune again while a batch is full and sums what every batch did', async () => {
    const { client, calls } = batchClient({ prune_operational_backend_data: [full(), full({ ai_usage_payloads_cleared: 7 }), last] });

    const summary = await pruneOperationalBackendData(client);

    expect(calls.filter((call) => call.fn === 'prune_operational_backend_data')).toHaveLength(3);
    expect(summary).toMatchObject({
      pruneBatches: 3,
      jobRunsDeleted: 11_200,
      rateLimitsDeleted: 20,
      playbackMetricsDeleted: 4,
      aiUsagePayloadsCleared: 7,
      totalDeleted: 11_224,
      batchLimitReached: false,
      pruneTimeBudgetReached: false,
    });
  });

  it('passes every batch the same arguments, so they agree on the sweep time and cap', async () => {
    const { client, calls } = batchClient({ prune_operational_backend_data: [full(), last] });

    await pruneOperationalBackendData(client, { now: new Date('2026-11-05T00:50:00.000Z'), maxDeletesPerTable: 100 });

    const batches = calls.filter((call) => call.fn === 'prune_operational_backend_data');
    expect(batches.map((call) => call.args)).toEqual([
      { p_now: '2026-11-05T00:50:00.000Z', p_max_deletes_per_table: 100 },
      { p_now: '2026-11-05T00:50:00.000Z', p_max_deletes_per_table: 100 },
    ]);
  });

  it('starts no batch past the first minute and says a backlog remains', async () => {
    let clockMs = 0;
    const { client, calls } = batchClient({
      prune_operational_backend_data: [
        { ...full(), data: { ...full().data } },
      ],
    });
    (client.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (fn: string) => {
      calls.push({ fn, args: {} });
      if (fn === 'prune_operational_backend_data') {
        clockMs += 25_000;
        return full();
      }
      return { data: fn.startsWith('list_idle_guest_identities') ? [] : 0, error: null };
    });

    const summary = await pruneOperationalBackendData(client, { clock: () => clockMs });

    // Batches at 0, 25 and 50 s; the third ends at 75 s, past the 60 s mark.
    expect(summary).toMatchObject({ pruneBatches: 3, batchLimitReached: true, pruneTimeBudgetReached: true });
  });

  it('stops at its batch backstop even when every batch is instant', async () => {
    const { client } = batchClient({ prune_operational_backend_data: [full()] });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.pruneBatches).toBe(OPERATIONAL_RETENTION_MAX_BATCHES);
    expect(summary.batchLimitReached).toBe(true);
  });

  it('keeps what earlier batches did when a later one fails, and runs the rest of the job', async () => {
    const { client, calls } = batchClient({
      prune_operational_backend_data: [full(), { error: { message: 'statement timeout' } }],
    });

    const summary = await pruneOperationalBackendData(client);

    expect(summary).toMatchObject({
      pruneBatches: 1,
      jobRunsDeleted: 5000,
      supplementaryPruneFailures: ['prune_operational_backend_data'],
    });
    expect(calls.map((call) => call.fn)).toContain('prune_upload_byte_reservations');
    expect(calls.map((call) => call.fn)).toContain('list_idle_guest_identities');
  });

  it('still fails the run when the first batch fails', async () => {
    const { client } = batchClient({
      prune_operational_backend_data: [() => { throw new Error('connection refused'); }],
    });

    await expect(pruneOperationalBackendData(client)).rejects.toThrow('connection refused');
  });

  it('calls a supplementary prune again while its batch of 5,000 is full', async () => {
    const { client, calls } = batchClient({
      prune_post_share_events: [{ data: 5000 }, { data: 5000 }, { data: 12 }],
      prune_upload_byte_reservations: [{ data: 5000 }, { data: 3 }],
    });

    const summary = await pruneOperationalBackendData(client);

    expect(calls.filter((call) => call.fn === 'prune_post_share_events')).toHaveLength(3);
    expect(calls.filter((call) => call.fn === 'prune_profile_share_events')).toHaveLength(1);
    expect(summary).toMatchObject({
      shareEventsDeleted: 10_012,
      uploadByteReservationsDeleted: 5003,
      supplementaryBatchLimitReached: false,
    });
  });

  it('gives the reservation sweep its full action limit and what is left of its step', async () => {
    let clockMs = 0;
    const { client } = batchClient({});
    (client.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (fn: string) => {
      if (fn === 'prune_operational_backend_data') clockMs += 30_000;
      return { data: fn.startsWith('list_idle_guest_identities') ? [] : fn === 'prune_operational_backend_data' ? { total_deleted: 0 } : 0, error: null };
    });

    await pruneOperationalBackendData(client, { clock: () => clockMs });

    expect(EXPIRED_UPLOAD_RESERVATION_RECLAIM_LIMIT).toBe(5000);
    expect(reclaimExpiredUploadReservationsMock).toHaveBeenCalledWith(client, expect.objectContaining({
      limit: 5000,
      // 210 s into the run is its step's end; 30 s went to the main prune.
      timeBudgetMs: 180_000,
    }));
  });
});

// Usage audit (2026-11-04): a guest that made something and has been unused for
// 180 days is retired through the account-deletion pipeline. Who qualifies is
// the database's decision (list_idle_guest_identities_with_content, pinned by
// guest_content_retirement.test.sql); this is the part that acts on it.
describe('retiring idle guests with content', () => {
  function guestId(index: number) {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  }

  function contentGuestClient(options: {
    listed?: string[];
    listResult?: { data: unknown; error: unknown };
    stillIdle?: (userId: string) => boolean;
  } = {}) {
    const order: string[] = [];
    const listCalls: Array<Record<string, unknown>> = [];
    const client = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === 'list_idle_guest_identities') return { data: [], error: null };
        if (fn !== 'list_idle_guest_identities_with_content') {
          return { data: fn === 'prune_operational_backend_data' ? { total_deleted: 0 } : 0, error: null };
        }
        listCalls.push(args);
        if (typeof args.p_user_id === 'string') {
          order.push(`recheck:${args.p_user_id}`);
          const idle = options.stillIdle?.(args.p_user_id) ?? true;
          return { data: idle ? [{ user_id: args.p_user_id }] : [], error: null };
        }
        order.push('list');
        if (options.listResult) return options.listResult;
        return {
          data: (options.listed ?? []).slice(0, Number(args.p_limit)).map((user_id) => ({ user_id })),
          error: null,
        };
      }),
      auth: { admin: { deleteUser: vi.fn() } },
    };
    return { client: client as unknown as SupabaseClient, order, listCalls };
  }

  beforeEach(() => {
    reclaimExpiredUploadReservationsMock.mockClear();
  });

  it('retires only the guests the database names, asking about each again right before', async () => {
    const guests = [guestId(1), guestId(2)];
    const { client, order } = contentGuestClient({ listed: guests });
    const retire = vi.fn(async (_admin: SupabaseClient, userId: string) => {
      order.push(`retire:${userId}`);
      return 'retired' as const;
    });

    const summary = await pruneOperationalBackendData(client, { retireContentGuest: retire });

    expect(order).toEqual([
      'list',
      `recheck:${guests[0]}`, `retire:${guests[0]}`,
      `recheck:${guests[1]}`, `retire:${guests[1]}`,
    ]);
    expect(retire.mock.calls.map(([admin]) => admin)).toEqual([client, client]);
    expect(summary).toMatchObject({
      contentGuestCandidates: 2,
      contentGuestsRetired: 2,
      contentGuestsSkipped: 0,
      contentGuestRetirementFailures: 0,
      contentGuestBatchLimitReached: false,
      supplementaryPruneFailures: [],
    });
  });

  it('asks for one small batch and says a backlog remains', async () => {
    const backlog = Array.from({ length: 25 }, (_, index) => guestId(index + 1));
    const { client, listCalls } = contentGuestClient({ listed: backlog });
    const retire = vi.fn(async () => 'retired' as const);

    const summary = await pruneOperationalBackendData(client, { retireContentGuest: retire });

    expect(IDLE_CONTENT_GUEST_RETIREMENT_BATCH_LIMIT).toBe(10);
    expect(listCalls[0]).toEqual({ p_limit: 10 });
    expect(retire).toHaveBeenCalledTimes(10);
    expect(summary).toMatchObject({ contentGuestCandidates: 10, contentGuestBatchLimitReached: true });
  });

  it('leaves alone a guest that came back, was linked, or is already gone', async () => {
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client } = contentGuestClient({ listed: guests, stillIdle: (userId) => userId !== guests[0] });
    const retire = vi.fn(async (_admin: SupabaseClient, userId: string) => {
      if (userId === guests[1]) throw new GuestAccountLinkedError();
      return 'already_deleted' as const;
    });

    const summary = await pruneOperationalBackendData(client, { retireContentGuest: retire });

    expect(retire.mock.calls.map(([, userId]) => userId)).toEqual([guests[1], guests[2]]);
    expect(summary).toMatchObject({
      contentGuestsRetired: 0,
      contentGuestsSkipped: 3,
      contentGuestRetirementFailures: 0,
      supplementaryPruneFailures: [],
    });
  });

  it('counts each failure, names it once, and stops after three in a row', async () => {
    const guests = [guestId(1), guestId(2), guestId(3), guestId(4)];
    const { client } = contentGuestClient({ listed: guests });
    const retire = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });

    const summary = await pruneOperationalBackendData(client, { retireContentGuest: retire });

    expect(retire).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      contentGuestRetirementFailures: 3,
      supplementaryPruneFailures: ['retire_idle_guest_with_content'],
    });
  });

  it('records a failed list and still completes the run', async () => {
    const { client } = contentGuestClient({ listResult: { data: null, error: { message: 'function does not exist' } } });
    const retire = vi.fn();

    const summary = await pruneOperationalBackendData(client, { retireContentGuest: retire });

    expect(retire).not.toHaveBeenCalled();
    expect(summary.supplementaryPruneFailures).toEqual(['list_idle_guest_identities_with_content']);
  });

  it('starts no retirement after 240 s of the run, leaving the one in flight its minute', async () => {
    let clockMs = 0;
    reclaimExpiredUploadReservationsMock.mockImplementationOnce(async () => {
      // The reservation sweep used its whole step: the guests begin at 225 s.
      clockMs += 225_000;
      return {
        scanned: 0, handled: 0, objectsDeleted: 0, absentObjectsReleased: 0, failed: 0,
        bytesDeleted: 0, scanLimitReached: false, timeBudgetReached: true, oldestCandidateExpiresAt: null,
      };
    });
    const guests = [guestId(1), guestId(2), guestId(3)];
    const { client } = contentGuestClient({ listed: guests });
    const retire = vi.fn(async () => {
      clockMs += 10_000;
      return 'retired' as const;
    });

    const summary = await pruneOperationalBackendData(client, { clock: () => clockMs, retireContentGuest: retire });

    expect(IDLE_CONTENT_GUEST_RETIREMENT_LAST_START_MS).toBe(240_000);
    // Started at 225 s and 235 s; the third would start at 245 s.
    expect(retire).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ contentGuestsRetired: 2, contentGuestTimeBudgetReached: true });
  });

  it('reads nothing once the run\'s time is spent', async () => {
    const { client, listCalls } = contentGuestClient({ listed: [guestId(1)] });

    const summary = await retireIdleGuestsWithContent(client, {
      clock: () => 270_000,
      deadlineMs: 270_000,
      retire: vi.fn(),
    });

    expect(listCalls).toEqual([]);
    expect(summary).toMatchObject({ contentGuestCandidates: 0, contentGuestTimeBudgetReached: true });
  });

  it('passes the sweep time to the database, so the list and every re-check agree', async () => {
    const { client, listCalls } = contentGuestClient({ listed: [guestId(1)] });

    await retireIdleGuestsWithContent(client, {
      now: new Date('2026-11-05T00:50:00.000Z'),
      retire: vi.fn(async () => 'retired' as const),
    });

    expect(listCalls).toEqual([
      { p_now: '2026-11-05T00:50:00.000Z', p_limit: 10 },
      { p_now: '2026-11-05T00:50:00.000Z', p_limit: 1, p_user_id: guestId(1) },
    ]);
  });
});
