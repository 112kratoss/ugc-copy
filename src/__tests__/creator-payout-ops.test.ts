import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { encryptCreatorPayoutDetails } from '@/lib/creator-payout-details-crypto';
import { listOpenCreatorPayoutRequests, resolveCreatorPayoutRequest } from '@/lib/creator-payout-ops';

const KEY = Buffer.alloc(32, 9).toString('base64');

function createSupabaseMock(requests: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === 'creator_payout_requests') {
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          limit: () => Promise.resolve({ data: requests, error: null }),
        };
        return builder;
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [{ id: 'creator-1', username: 'maker', display_name: 'Maker' }],
              error: null,
            }),
          }),
        };
      }
      if (table === 'creator_resource_wallets') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [{ user_id: 'creator-1', lifetime_earned_token_subunits: 2_000_000 }],
              error: null,
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function requestRow(payoutDetails: string): Record<string, unknown> {
  return {
    id: 'request-1',
    user_id: 'creator-1',
    amount_token_subunits: 1_500_000,
    payout_method: 'upi',
    payout_details: payoutDetails,
    requested_at: '2026-08-18T10:00:00.000Z',
  };
}

describe('listOpenCreatorPayoutRequests', () => {
  it('decrypts stored payout details for the operator queue', async () => {
    vi.stubEnv('CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY', KEY);
    try {
      const stored = encryptCreatorPayoutDetails('creator@upi, contact +91 98x');
      const queue = await listOpenCreatorPayoutRequests(createSupabaseMock([requestRow(stored)]));

      expect(queue).toHaveLength(1);
      expect(queue[0].payoutDetails).toBe('creator@upi, contact +91 98x');
      expect(queue[0].amountUsd).toBe('$150.00');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes legacy plaintext rows through unchanged', async () => {
    vi.stubEnv('CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY', KEY);
    try {
      const queue = await listOpenCreatorPayoutRequests(
        createSupabaseMock([requestRow('creator@upi (pre-encryption row)')]),
      );

      expect(queue[0].payoutDetails).toBe('creator@upi (pre-encryption row)');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the queue rendering when one row cannot be decrypted', async () => {
    vi.stubEnv('CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY', KEY);
    try {
      const stored = encryptCreatorPayoutDetails('creator@upi');
      const tampered = `${stored.slice(0, -4)}AAAA`;
      const queue = await listOpenCreatorPayoutRequests(createSupabaseMock([requestRow(tampered)]));

      // A broken or re-keyed row must not take the whole operator view down,
      // and must never leak ciphertext as if it were account details.
      expect(queue).toHaveLength(1);
      expect(queue[0].payoutDetails).toBe('[payout details unavailable: stored ciphertext failed to decrypt]');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveCreatorPayoutRequest', () => {
  /**
   * A request the operator is settling, as the resolution reads it afterwards,
   * and the resolution's own answer. Notifications land in `history`.
   */
  function settling(request: Record<string, unknown>, answer: Record<string, unknown>) {
    const history = createMobileNotificationHistory();
    const resolve = vi.fn(() => answer);
    const stored = createStoredRows(
      { creator_payout_requests: [{ id: 'request-1', user_id: 'creator-1', resolution_note: null, ...request }] },
      { resolve_creator_payout_request: resolve },
    );
    return {
      adminSupabase: withMobileNotificationHistory(stored.client, history),
      history,
      reads: stored.reads,
      resolve,
    };
  }

  const settle = (adminSupabase: SupabaseClient, action: 'mark_paid' | 'reject', resolutionNote: string | null) => (
    resolveCreatorPayoutRequest({
      adminSupabase,
      requestId: 'request-1',
      reviewerUserId: 'reviewer-1',
      action,
      resolutionNote,
    })
  );

  it('tells the creator their payout was sent', async () => {
    const { adminSupabase, history, reads } = settling(
      { resolution_note: 'UTR 4471' },
      { status: 'paid', request_id: 'request-1', amount_token_subunits: 1_500_000 },
    );

    await expect(settle(adminSupabase, 'mark_paid', 'UTR 4471'))
      .resolves.toEqual({ ok: true, status: 'paid', amountTokenSubunits: 1_500_000 });

    // The resolution's answer names no one, so the request is read for whose it is.
    expect(reads).toEqual([{ table: 'creator_payout_requests', columns: ['user_id', 'resolution_note'] }]);
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'creator-1',
      type: 'creator_payout_paid',
      category: 'commerce',
      title: 'Payout sent',
      body: 'We sent $150.00 to your payout account.',
      deep_link: '/seller-dashboard',
      dedupe_key: 'creator-payout:request-1:paid',
    })]);
  });

  it('tells the creator a payout was not sent, with the reason as it was stored', async () => {
    const { adminSupabase, history, resolve } = settling(
      { resolution_note: 'The UPI id did not match the account name' },
      { status: 'rejected', request_id: 'request-1', amount_token_subunits: 1_500_000 },
    );

    await expect(settle(adminSupabase, 'reject', '  The UPI id did not match the account name  '))
      .resolves.toEqual({ ok: true, status: 'rejected', amountTokenSubunits: 1_500_000 });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      p_action: 'reject',
      p_resolution_note: '  The UPI id did not match the account name  ',
    }));
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'creator-1',
      type: 'creator_payout_rejected',
      category: 'commerce',
      title: 'Payout not sent',
      body: 'The UPI id did not match the account name. $150.00 is back in your payout balance.',
      deep_link: '/seller-dashboard',
    })]);
  });

  it('tells no one about a request whose account was deleted', async () => {
    // Payouts survive account deletion; the request keeps only the detached id.
    const { adminSupabase, history } = settling(
      { user_id: null },
      { status: 'paid', request_id: 'request-1', amount_token_subunits: 1_500_000 },
    );

    await expect(settle(adminSupabase, 'mark_paid', null))
      .resolves.toEqual({ ok: true, status: 'paid', amountTokenSubunits: 1_500_000 });
    expect(history.sent).toEqual([]);
  });

  it.each([
    ['already settled', { status: 'already_resolved', current_status: 'paid' }],
    ['missing', { status: 'not_found' }],
    ['refused for want of a reason', { status: 'reason_required' }],
  ])('tells no one when the request was %s', async (_case, answer) => {
    const { adminSupabase, history, reads } = settling({}, answer);

    await expect(settle(adminSupabase, 'reject', null)).resolves.toMatchObject({ ok: false });
    expect(reads).toEqual([]);
    expect(history.sent).toEqual([]);
  });

  it('still settles the payout when the request cannot be read back', async () => {
    const history = createMobileNotificationHistory();
    const unreadable = {
      rpc: async () => ({
        data: { status: 'paid', request_id: 'request-1', amount_token_subunits: 1_500_000 },
        error: null,
      }),
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(settle(withMobileNotificationHistory(unreadable, history), 'mark_paid', null))
        .resolves.toEqual({ ok: true, status: 'paid', amountTokenSubunits: 1_500_000 });
    } finally {
      restoreLogSink();
    }

    expect(logged.map((record) => record.msg)).toEqual(['creator_payout_notification_failed']);
    expect(history.sent).toEqual([]);
  });
});
