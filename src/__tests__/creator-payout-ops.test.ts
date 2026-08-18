import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { encryptCreatorPayoutDetails } from '@/lib/creator-payout-details-crypto';
import { listOpenCreatorPayoutRequests } from '@/lib/creator-payout-ops';

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
