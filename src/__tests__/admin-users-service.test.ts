import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { getAdminUserDetail } from '@/lib/admin-users-service';

const USER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';

type TableRows = Record<string, Array<Record<string, unknown>> | Record<string, unknown> | null>;

/**
 * Minimal PostgREST stand-in. `filterLog` records the filters applied per table
 * so the tests can assert the `.is('mobile_product_id', null)` guard that keeps
 * a mobile purchase from appearing twice in a user's history.
 */
function createClient(rows: TableRows, filterLog: Record<string, string[]> = {}) {
  return {
    from(table: string) {
      filterLog[table] ??= [];
      const result = { data: rows[table] ?? [], error: null, count: 0 };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        gte: chain,
        in: chain,
        order: chain,
        is: (column: string, value: unknown) => {
          filterLog[table].push(`is:${column}=${String(value)}`);
          return builder;
        },
        limit: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve({
          data: Array.isArray(rows[table]) ? (rows[table] as unknown[])[0] ?? null : rows[table] ?? null,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      });
      return builder;
    },
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null } }) } },
  } as unknown as SupabaseClient;
}

const PROFILE = {
  id: USER_ID,
  username: 'creator',
  display_name: 'Creator',
  credits: 100,
  promotional_credits: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('admin user purchase history', () => {
  it('excludes the mirrored ledger row a mobile purchase writes to transactions', async () => {
    const filterLog: Record<string, string[]> = {};
    const client = createClient(
      {
        profiles: [PROFILE],
        transactions: [],
        mobile_store_transactions: [{
          id: 'mst-1',
          status: 'active',
          amount_subunits: 830000,
          currency: 'INR',
          credits: 5000,
          created_at: '2026-07-21T21:52:00.000Z',
          product_id: 'magicbooklet.credits.pro',
        }],
        credit_grants: [],
        creator_resource_wallets: null,
        generations: [],
        ai_usage_events: [],
      },
      filterLog,
    );

    const detail = await getAdminUserDetail(client, USER_ID);

    // Without the filter the same purchase is listed twice, and the ledger copy
    // is mislabelled as a web Razorpay payment.
    expect(filterLog.transactions).toContain('is:mobile_product_id=null');
    expect(detail?.purchases).toHaveLength(1);
    expect(detail?.purchases[0]).toMatchObject({ kind: 'mobile-iap', currency: 'INR' });
  });

  it('preserves each purchase currency instead of assuming INR', async () => {
    const client = createClient({
      profiles: [PROFILE],
      transactions: [],
      mobile_store_transactions: [{
        id: 'mst-usd',
        status: 'active',
        amount_subunits: 1000,
        currency: 'USD',
        credits: 100,
        created_at: '2026-07-21T00:00:00.000Z',
        product_id: 'magicbooklet.credits.starter',
      }],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
      ai_usage_events: [],
    });

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.purchases[0].currency).toBe('USD');
  });

  it('labels a web credit purchase as Razorpay INR', async () => {
    const client = createClient({
      profiles: [PROFILE],
      transactions: [{
        id: 'txn-1',
        status: 'success',
        amount: 41500,
        credits: 500,
        created_at: '2026-07-20T00:00:00.000Z',
        razorpay_payment_id: 'pay_abc123',
      }],
      mobile_store_transactions: [],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
      ai_usage_events: [],
    });

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.purchases[0]).toMatchObject({
      kind: 'razorpay',
      currency: 'INR',
      reference: 'pay_abc123',
    });
  });

  it('rejects a non-UUID user id rather than issuing a broad query', async () => {
    const client = createClient({ profiles: [PROFILE] });
    await expect(getAdminUserDetail(client, 'not-a-uuid')).rejects.toThrow(/UUID/);
  });
});
