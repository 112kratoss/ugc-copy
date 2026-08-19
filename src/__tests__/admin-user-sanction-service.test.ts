import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  applyAdminUserSanction,
  getAdminUserAccountStates,
  isValidSanctionDuration,
} from '@/lib/admin-user-sanction-service';

const USER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const REVIEWER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function rpcClient(response: Record<string, unknown>, calls: unknown[][] = []) {
  return {
    rpc: (fn: string, args: unknown) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: response, error: null });
    },
  } as unknown as SupabaseClient;
}

describe('applyAdminUserSanction', () => {
  it('forwards a suspension with its duration and returns the applied state', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient(
      { status: 'applied', sanction_id: 's1', action: 'suspend', suspended_until: '2026-08-26T00:00:00.000Z' },
      calls,
    );

    const result = await applyAdminUserSanction(client, {
      userId: USER_ID,
      reviewerId: REVIEWER_ID,
      action: 'suspend',
      reason: '  Confirmed spam ring.  ',
      durationHours: 168,
      idempotencyKey: 'key-1',
    });

    expect(calls[0][0]).toBe('apply_admin_user_sanction');
    expect(calls[0][1]).toMatchObject({
      p_user_id: USER_ID,
      p_reviewer_id: REVIEWER_ID,
      p_action: 'suspend',
      p_reason: 'Confirmed spam ring.',
      p_duration_hours: 168,
      p_idempotency_key: 'key-1',
    });
    expect(result.status).toBe('applied');
    expect(result.suspendedUntil).toBe('2026-08-26T00:00:00.000Z');
  });

  /**
   * The table constrains a reinstatement to carry no expiry, so a duration that
   * leaked through would fail the insert rather than being quietly ignored.
   */
  it('drops any duration supplied alongside a reinstatement', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', action: 'reinstate' }, calls);

    await applyAdminUserSanction(client, {
      userId: USER_ID,
      reviewerId: REVIEWER_ID,
      action: 'reinstate',
      reason: 'Appeal upheld.',
      durationHours: 168,
    });

    expect(calls[0][1]).toMatchObject({ p_action: 'reinstate', p_duration_hours: null });
  });

  it('mints an idempotency key when the caller omits one', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', action: 'suspend' }, calls);

    await applyAdminUserSanction(client, {
      userId: USER_ID, reviewerId: REVIEWER_ID, action: 'suspend', reason: 'Spam.',
    });

    const args = calls[0][1] as Record<string, unknown>;
    expect(String(args.p_idempotency_key)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an off-menu duration rather than passing it to the database', async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as SupabaseClient;

    const result = await applyAdminUserSanction(client, {
      userId: USER_ID, reviewerId: REVIEWER_ID, action: 'suspend', reason: 'Spam.', durationHours: 99999,
    });

    expect(result.status).toBe('invalid');
    expect(result.error).toMatch(/duration/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires a rationale before any database call', async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as SupabaseClient;

    const result = await applyAdminUserSanction(client, {
      userId: USER_ID, reviewerId: REVIEWER_ID, action: 'suspend', reason: '  ',
    });

    expect(result.status).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID target instead of letting PostgREST interpret it', async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as SupabaseClient;

    const result = await applyAdminUserSanction(client, {
      userId: 'not-a-uuid', reviewerId: REVIEWER_ID, action: 'suspend', reason: 'Spam.',
    });

    expect(result.status).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces a replayed sanction as already_applied', async () => {
    const client = rpcClient({ status: 'already_applied', sanction_id: 's1', action: 'suspend' });

    const result = await applyAdminUserSanction(client, {
      userId: USER_ID, reviewerId: REVIEWER_ID, action: 'suspend', reason: 'Spam.', idempotencyKey: 'k',
    });

    expect(result.status).toBe('already_applied');
  });
});

describe('isValidSanctionDuration', () => {
  it('accepts the offered durations and indefinite', () => {
    expect(isValidSanctionDuration(24)).toBe(true);
    expect(isValidSanctionDuration(168)).toBe(true);
    expect(isValidSanctionDuration(720)).toBe(true);
    expect(isValidSanctionDuration(null)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidSanctionDuration(1)).toBe(false);
    expect(isValidSanctionDuration(100000)).toBe(false);
  });
});

describe('getAdminUserAccountStates', () => {
  it('skips the query entirely when there is nothing to resolve', async () => {
    const from = vi.fn();
    const client = { from } as unknown as SupabaseClient;

    const states = await getAdminUserAccountStates(client, []);

    expect(states.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it('drops ids that are not UUIDs before building the filter', async () => {
    const calls: unknown[][] = [];
    const client = {
      from: () => ({
        select: () => ({
          in: (column: string, ids: unknown) => {
            calls.push([column, ids]);
            return Promise.resolve({ data: [], error: null });
          },
        }),
      }),
    } as unknown as SupabaseClient;

    await getAdminUserAccountStates(client, [USER_ID, 'nope', USER_ID]);

    expect(calls[0]).toEqual(['user_id', [USER_ID]]);
  });

  it('maps live suspension state per account', async () => {
    const client = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({
            data: [
              { user_id: USER_ID, banned_until: '2026-08-26T00:00:00.000Z', is_suspended: true },
              { user_id: REVIEWER_ID, banned_until: null, is_suspended: false },
            ],
            error: null,
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const states = await getAdminUserAccountStates(client, [USER_ID, REVIEWER_ID]);

    expect(states.get(USER_ID)).toEqual({ isSuspended: true, bannedUntil: '2026-08-26T00:00:00.000Z' });
    expect(states.get(REVIEWER_ID)).toEqual({ isSuspended: false, bannedUntil: null });
  });
});
