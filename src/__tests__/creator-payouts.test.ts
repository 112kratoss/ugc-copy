import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
  formatTokenSubunitsAsUsd,
  getCreatorPayoutState,
  isCreatorPayoutMethod,
  requestCreatorPayout,
  tokenSubunitsToUsdCents,
} from '@/lib/creator-payouts';

function createSupabaseMock({
  wallet,
  requests = [],
  rpcResult,
}: {
  wallet?: Record<string, number> | null;
  requests?: Array<Record<string, unknown>>;
  rpcResult?: Record<string, unknown>;
}) {
  const rpc = vi.fn(async () => ({ data: rpcResult ?? {}, error: null }));
  const client = {
    rpc,
    from(table: string) {
      if (table === 'creator_resource_wallets') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return { data: wallet ?? null, error: null };
          },
        };
        return query;
      }

      if (table === 'creator_payout_requests') {
        const query = {
          select() { return query; },
          eq() { return query; },
          order() { return query; },
          limit() { return Promise.resolve({ data: requests, error: null }); },
        };
        return query;
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, rpc };
}

describe('creator payout money math', () => {
  it('sets the withdrawal floor at $100', () => {
    // 100 tokens per dollar, 100 subunits per token.
    expect(CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS).toBe(1_000_000);
    expect(formatTokenSubunitsAsUsd(CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS)).toBe('$100.00');
  });

  it('floors subunits to whole cents rather than rounding up', () => {
    // Rounding up would let a wallet pay out a cent it never earned.
    expect(tokenSubunitsToUsdCents(199)).toBe(1);
    expect(tokenSubunitsToUsdCents(150_050)).toBe(1500);
    expect(formatTokenSubunitsAsUsd(150_050)).toBe('$15.00');
  });

  it('accepts only the payout methods the operator can actually settle', () => {
    expect(isCreatorPayoutMethod('upi')).toBe(true);
    expect(isCreatorPayoutMethod('bank_transfer')).toBe(true);
    expect(isCreatorPayoutMethod('crypto')).toBe(false);
    expect(isCreatorPayoutMethod(null)).toBe(false);
  });
});

describe('getCreatorPayoutState', () => {
  it('unlocks the request button only once the balance clears the floor', async () => {
    const { client } = createSupabaseMock({
      wallet: {
        available_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
        held_token_subunits: 0,
        lifetime_earned_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
        lifetime_paid_out_token_subunits: 0,
      },
    });

    const state = await getCreatorPayoutState({ adminSupabase: client, userId: 'creator-1' });

    expect(state.canRequest).toBe(true);
    expect(state.availableUsd).toBe('$100.00');
  });

  it('keeps the button locked one subunit short', async () => {
    const { client } = createSupabaseMock({
      wallet: {
        available_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS - 1,
        held_token_subunits: 0,
        lifetime_earned_token_subunits: 0,
        lifetime_paid_out_token_subunits: 0,
      },
    });

    const state = await getCreatorPayoutState({ adminSupabase: client, userId: 'creator-1' });

    expect(state.canRequest).toBe(false);
  });

  it('keeps the button locked while a request is in flight, however large the balance', async () => {
    const { client } = createSupabaseMock({
      wallet: {
        available_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS * 5,
        held_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
        lifetime_earned_token_subunits: 0,
        lifetime_paid_out_token_subunits: 0,
      },
      requests: [{
        id: 'request-1',
        amount_token_subunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
        status: 'requested',
        payout_method: 'upi',
        requested_at: '2026-07-20T00:00:00.000Z',
        resolved_at: null,
        resolution_note: null,
        external_reference: null,
      }],
    });

    const state = await getCreatorPayoutState({ adminSupabase: client, userId: 'creator-1' });

    expect(state.canRequest).toBe(false);
    expect(state.pendingRequest?.id).toBe('request-1');
  });

  it('reports an empty wallet rather than failing for a creator who never sold', async () => {
    const { client } = createSupabaseMock({ wallet: null });

    const state = await getCreatorPayoutState({ adminSupabase: client, userId: 'creator-1' });

    expect(state.availableTokenSubunits).toBe(0);
    expect(state.canRequest).toBe(false);
    expect(state.history).toEqual([]);
  });

  it('surfaces the rejection reason so the creator can fix it', async () => {
    const { client } = createSupabaseMock({
      wallet: null,
      requests: [{
        id: 'request-1',
        amount_token_subunits: 1_000_000,
        status: 'rejected',
        payout_method: 'upi',
        requested_at: '2026-07-20T00:00:00.000Z',
        resolved_at: '2026-07-21T00:00:00.000Z',
        resolution_note: 'Bank details did not match the account name.',
        external_reference: null,
      }],
    });

    const state = await getCreatorPayoutState({ adminSupabase: client, userId: 'creator-1' });

    expect(state.history[0].resolutionNote).toBe('Bank details did not match the account name.');
    expect(state.pendingRequest).toBeNull();
  });
});

describe('requestCreatorPayout', () => {
  it('passes the caller id straight to the row-locking RPC', async () => {
    const { client, rpc } = createSupabaseMock({
      rpcResult: { status: 'requested', request_id: 'request-1', amount_token_subunits: 1_500_000 },
    });

    const result = await requestCreatorPayout({
      adminSupabase: client,
      userId: 'creator-1',
      payoutMethod: 'upi',
      payoutDetails: 'creator@upi',
    });

    expect(rpc).toHaveBeenCalledWith('request_creator_payout', {
      p_user_id: 'creator-1',
      p_payout_method: 'upi',
      p_payout_details: 'creator@upi',
    });
    expect(result).toEqual({ ok: true, requestId: 'request-1', amountTokenSubunits: 1_500_000 });
  });

  it('maps a concurrent second request to a conflict, not a generic failure', async () => {
    const { client } = createSupabaseMock({ rpcResult: { status: 'already_pending' } });

    const result = await requestCreatorPayout({
      adminSupabase: client,
      userId: 'creator-1',
      payoutMethod: 'upi',
      payoutDetails: 'creator@upi',
    });

    expect(result).toMatchObject({ ok: false, status: 409, code: 'ALREADY_PENDING' });
  });

  it('explains the floor in dollars when the balance is short', async () => {
    const { client } = createSupabaseMock({ rpcResult: { status: 'below_minimum' } });

    const result = await requestCreatorPayout({
      adminSupabase: client,
      userId: 'creator-1',
      payoutMethod: 'upi',
      payoutDetails: 'creator@upi',
    });

    expect(result).toMatchObject({ ok: false, status: 400, code: 'BELOW_MINIMUM' });
    expect(result.ok === false && result.error).toContain('$100.00');
  });

  it('rejects a request with no destination details', async () => {
    const { client } = createSupabaseMock({ rpcResult: { status: 'invalid_details' } });

    const result = await requestCreatorPayout({
      adminSupabase: client,
      userId: 'creator-1',
      payoutMethod: 'upi',
      payoutDetails: ' ',
    });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_DETAILS' });
  });

  it('bounds the plaintext length before encryption, not after', async () => {
    // The DB CHECK now sizes ciphertext, so it can no longer bound what the
    // creator typed; the service must.
    const { client, rpc } = createSupabaseMock({});

    const result = await requestCreatorPayout({
      adminSupabase: client,
      userId: 'creator-1',
      payoutMethod: 'upi',
      payoutDetails: 'x'.repeat(501),
    });

    expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_DETAILS' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('stores ciphertext, never plaintext, when the encryption key is configured', async () => {
    vi.stubEnv(
      'CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY',
      Buffer.alloc(32, 7).toString('base64'),
    );
    try {
      const { client, rpc } = createSupabaseMock({
        rpcResult: { status: 'requested', request_id: 'request-1', amount_token_subunits: 1_500_000 },
      });

      await requestCreatorPayout({
        adminSupabase: client,
        userId: 'creator-1',
        payoutMethod: 'upi',
        payoutDetails: '  creator@upi  ',
      });

      const [, rpcArgs] = rpc.mock.calls[0] as unknown as [string, { p_payout_details: string }];
      const stored = rpcArgs.p_payout_details;
      expect(stored.startsWith('enc.v1.')).toBe(true);
      expect(stored).not.toContain('creator@upi');

      const { decryptCreatorPayoutDetails } = await import('@/lib/creator-payout-details-crypto');
      expect(decryptCreatorPayoutDetails(stored)).toEqual({
        ok: true,
        plaintext: 'creator@upi',
        encrypted: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
