import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hashAccountMergeTicket,
  mergeGuestAccountForRoute,
  prepareAccountMergeTicketForRoute,
} from '@/lib/account-merge-service';

const logBackendErrorMock = vi.fn();

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => logBackendErrorMock(...args),
}));

const enforceBackendRateLimitMock = vi.fn(async (...args: unknown[]) => {
  void args;
});

vi.mock('@/lib/backend-rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backend-rate-limit')>(
    '@/lib/backend-rate-limit',
  );
  return {
    ...actual,
    enforceBackendRateLimit: (...args: unknown[]) => enforceBackendRateLimitMock(...args),
  };
});

const TICKET = 'f'.repeat(64);

type MockUser = { id: string; is_anonymous?: boolean };

function createHarness(options: {
  callerUser?: MockUser | null;
  linkedGuest?: boolean;
  rpcResult?: { data: unknown; error: unknown };
  insertError?: unknown;
} = {}) {
  const {
    callerUser = { id: 'registered-1', is_anonymous: false },
    linkedGuest = false,
    rpcResult = {
      data: {
        status: 'merged',
        credits_moved: 500,
        promotional_credits_moved: 0,
        credits: 525,
      },
      error: null,
    },
    insertError = null,
  } = options;

  // Typed argument, so `insert.mock.calls[0][0]` is a real record rather than
  // an empty tuple that typecheck:tests rejects.
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    void row;
    return { error: insertError };
  });
  const rpc = vi.fn(async () => rpcResult);
  const admin = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const query = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn(async () => ({
            data: { identity_state: linkedGuest ? 'merged' : 'active' },
            error: null,
          })),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }
      if (table === 'account_merge_tickets') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  const userSupabase = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: callerUser },
        error: callerUser ? null : new Error('no session'),
      })),
    },
  };

  return { admin, rpc, insert, userSupabase };
}

describe('guest account merge tickets', () => {
  beforeEach(() => {
    logBackendErrorMock.mockClear();
    enforceBackendRateLimitMock.mockClear();
    enforceBackendRateLimitMock.mockImplementation(async () => undefined);
  });

  describe('preparing', () => {
    it('fails closed when the identity-state client cannot be created', async () => {
      const harness = createHarness({ callerUser: { id: 'guest-1', is_anonymous: true } });
      const result = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => {
          throw new Error('service configuration unavailable');
        },
        userSupabase: harness.userSupabase,
      });

      expect(result).toEqual({
        ok: false,
        status: 503,
        body: {
          error: 'Identity verification is temporarily unavailable. Please try again.',
          code: 'IDENTITY_CHECK_UNAVAILABLE',
        },
      });
      expect(harness.insert).not.toHaveBeenCalled();
      expect(enforceBackendRateLimitMock).not.toHaveBeenCalled();
    });

    it('mints a ticket for an active guest and stores only its hash', async () => {
      // The stored value must never be the ticket itself: a dump of the table
      // would otherwise let anyone attach that device's credits to their account.
      const harness = createHarness({ callerUser: { id: 'guest-1', is_anonymous: true } });
      const result = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => harness.admin,
        userSupabase: harness.userSupabase,
      });

      expect(result.ok).toBe(true);
      const ticket = result.ok ? result.body.ticket : '';
      expect(ticket).toMatch(/^[a-f0-9]{64}$/);

      const inserted = harness.insert.mock.calls[0][0];
      expect(inserted.ticket_hash).toBe(hashAccountMergeTicket(ticket));
      expect(inserted.ticket_hash).not.toBe(ticket);
      expect(inserted.guest_user_id).toBe('guest-1');
    });

    it('gives every request a different ticket', async () => {
      const first = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => createHarness({ callerUser: { id: 'g', is_anonymous: true } }).admin,
        userSupabase: createHarness({ callerUser: { id: 'g', is_anonymous: true } }).userSupabase,
      });
      const second = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => createHarness({ callerUser: { id: 'g', is_anonymous: true } }).admin,
        userSupabase: createHarness({ callerUser: { id: 'g', is_anonymous: true } }).userSupabase,
      });

      expect(first.ok && second.ok && first.body.ticket).not.toBe(second.ok ? second.body.ticket : '');
    });

    it('refuses a registered caller', async () => {
      // Only a guest has anything to hand over; a ticket minted here could only
      // ever redeem to not_eligible.
      const harness = createHarness();
      const result = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => harness.admin,
        userSupabase: harness.userSupabase,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(400);
      expect(harness.insert).not.toHaveBeenCalled();
    });

    it('refuses a guest session that has already been linked', async () => {
      const harness = createHarness({
        callerUser: { id: 'guest-1', is_anonymous: true },
        linkedGuest: true,
      });
      const result = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => harness.admin,
        userSupabase: harness.userSupabase,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(409);
      expect(!result.ok && result.body.code).toBe('SESSION_MERGED');
    });

    it('never logs the ticket when storing it fails', async () => {
      const harness = createHarness({
        callerUser: { id: 'guest-1', is_anonymous: true },
        insertError: new Error('insert failed'),
      });
      const result = await prepareAccountMergeTicketForRoute({
        getAdminSupabase: () => harness.admin,
        userSupabase: harness.userSupabase,
      });

      expect(result.ok).toBe(false);
      const logged = JSON.stringify(logBackendErrorMock.mock.calls);
      expect(logged).not.toMatch(/[a-f0-9]{64}/);
    });
  });

  describe('redeeming', () => {
    function redeem(harness: ReturnType<typeof createHarness>, body: unknown = { ticket: TICKET }) {
      return mergeGuestAccountForRoute({
        getAdminSupabase: () => harness.admin,
        requestBody: body,
        userSupabase: harness.userSupabase,
      });
    }

    it('fails closed when the identity-state client cannot be created', async () => {
      const harness = createHarness();
      const result = await mergeGuestAccountForRoute({
        getAdminSupabase: () => {
          throw new Error('service configuration unavailable');
        },
        requestBody: { ticket: TICKET },
        userSupabase: harness.userSupabase,
      });

      expect(result).toEqual({
        ok: false,
        status: 503,
        body: {
          error: 'Identity verification is temporarily unavailable. Please try again.',
          code: 'IDENTITY_CHECK_UNAVAILABLE',
        },
      });
      expect(harness.rpc).not.toHaveBeenCalled();
      expect(enforceBackendRateLimitMock).not.toHaveBeenCalled();
    });

    it('links the guest data to the registered caller', async () => {
      const harness = createHarness();
      const result = await redeem(harness);

      expect(result.ok).toBe(true);
      expect(harness.rpc).toHaveBeenCalledWith('redeem_account_merge_ticket', {
        p_ticket_hash: hashAccountMergeTicket(TICKET),
        p_target_user_id: 'registered-1',
        p_source_surface: 'mobile',
      });
      expect(result.ok && result.body).toEqual({
        status: 'merged',
        creditsMoved: 500,
        promotionalCreditsMoved: 0,
        credits: 525,
      });
    });

    it('sends the hash, never the raw ticket, to the database', async () => {
      const harness = createHarness();
      await redeem(harness);

      const args = JSON.stringify(harness.rpc.mock.calls[0]);
      expect(args).toContain(hashAccountMergeTicket(TICKET));
      expect(args).not.toContain(TICKET);
    });

    it('refuses a guest caller', async () => {
      // Guest-absorbs-guest would chain links, which account_merges does not
      // model — it assumes the target is terminal.
      const harness = createHarness({ callerUser: { id: 'guest-2', is_anonymous: true } });
      const result = await redeem(harness);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(403);
      expect(harness.rpc).not.toHaveBeenCalled();
    });

    it('requires an authenticated caller', async () => {
      const harness = createHarness({ callerUser: null });
      const result = await redeem(harness);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(401);
      expect(enforceBackendRateLimitMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed ticket before reaching the database', async () => {
      const harness = createHarness();
      const result = await redeem(harness, { ticket: 'not-a-ticket' });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(400);
      expect(harness.rpc).not.toHaveBeenCalled();
    });

    it('passes a replayed redemption back as success', async () => {
      const harness = createHarness({
        rpcResult: {
          data: { status: 'already_merged', credits_moved: 500, promotional_credits_moved: 0, credits: 525 },
          error: null,
        },
      });
      const result = await redeem(harness);

      expect(result.ok).toBe(true);
      expect(result.ok && result.body.status).toBe('already_merged');
    });

    it('surfaces expiry and conflict without claiming a transfer', async () => {
      for (const status of ['expired', 'conflict'] as const) {
        const harness = createHarness({
          rpcResult: {
            data: { status, credits_moved: 0, promotional_credits_moved: 0, credits: 25 },
            error: null,
          },
        });
        const result = await redeem(harness);

        expect(result.ok).toBe(true);
        expect(result.ok && result.body.status).toBe(status);
        expect(result.ok && result.body.creditsMoved).toBe(0);
      }
    });

    it('rate limits on the registering account', async () => {
      const harness = createHarness();
      await redeem(harness);

      expect(enforceBackendRateLimitMock).toHaveBeenCalledWith(
        harness.admin,
        expect.objectContaining({ scope: 'account:merge-guest', key: 'registered-1' }),
      );
    });

    it('does not leak database detail when redemption fails', async () => {
      const harness = createHarness({ rpcResult: { data: null, error: new Error('deadlock detected') } });
      const result = await redeem(harness);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(500);
      expect(!result.ok && JSON.stringify(result.body)).not.toContain('deadlock');
      expect(logBackendErrorMock).toHaveBeenCalledWith('account_merge_failed', expect.anything());
    });
  });
});
