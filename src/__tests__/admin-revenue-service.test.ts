import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { collectAdminRevenueReport } from '@/lib/admin-revenue-service';

type TableRows = Record<string, Array<Record<string, unknown>>>;

/**
 * Minimal PostgREST query-builder stand-in. It records which filters a table
 * query applied so the tests can assert on the `.is('mobile_product_id', null)`
 * guard that keeps mobile purchases off the web rail.
 */
function createClient(rows: TableRows, filterLog: Record<string, string[]> = {}) {
  return {
    from(table: string) {
      filterLog[table] ??= [];
      const builder = {
        select: () => builder,
        gte: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
        is: (column: string, value: unknown) => {
          filterLog[table].push(`is:${column}=${String(value)}`);
          return builder;
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date('2026-07-28T00:00:00.000Z');

describe('admin revenue report', () => {
  it('does not double-count a mobile purchase that also wrote a transactions row', async () => {
    const filterLog: Record<string, string[]> = {};
    // A mobile IAP writes to both tables, linked by source_record_id. Only the
    // mobile rail should report it.
    const client = createClient(
      {
        transactions: [],
        mobile_store_transactions: [{
          id: 'mst-1',
          user_id: 'user-1',
          status: 'active',
          amount_subunits: 830000,
          currency: 'INR',
          credits: 5000,
          created_at: '2026-07-21T21:52:00.000Z',
          product_id: 'magicbooklet.credits.pro',
        }],
        marketplace_orders: [],
        post_resource_bundle_orders: [],
        creator_resource_wallets: [],
      },
      filterLog,
    );

    const report = await collectAdminRevenueReport(client, { now: NOW });
    const web = report.rails.find((rail) => rail.key === 'razorpay-credits');
    const mobile = report.rails.find((rail) => rail.key === 'mobile-iap');

    expect(filterLog.transactions).toContain('is:mobile_product_id=null');
    expect(web?.grossSubunits).toBe(0);
    expect(mobile?.grossSubunits).toBe(830000);
    expect(report.recentOrders).toHaveLength(1);
  });

  it('counts only settled money toward gross', async () => {
    const client = createClient({
      transactions: [
        { id: 't1', status: 'success', amount: 41500, credits: 500, created_at: '2026-07-20T00:00:00.000Z' },
        { id: 't2', status: 'created', amount: 41500, credits: 500, created_at: '2026-07-21T00:00:00.000Z' },
        { id: 't3', status: 'failed', amount: 41500, credits: 500, created_at: '2026-07-22T00:00:00.000Z' },
      ],
      mobile_store_transactions: [],
      marketplace_orders: [],
      post_resource_bundle_orders: [],
      creator_resource_wallets: [],
    });

    const report = await collectAdminRevenueReport(client, { now: NOW });
    const web = report.rails.find((rail) => rail.key === 'razorpay-credits');

    // A `created` intent routinely never completes; counting it would inflate
    // gross with money that was never captured.
    expect(web?.grossSubunits).toBe(41500);
    expect(web?.creditsIssued).toBe(500);
    expect(web?.succeededCount).toBe(1);
    expect(web?.pendingCount).toBe(1);
    expect(web?.failedCount).toBe(1);
  });

  it('reports rails separately rather than blending currencies', async () => {
    const client = createClient({
      transactions: [{ id: 't1', status: 'success', amount: 10000, credits: 100, created_at: '2026-07-20T00:00:00.000Z' }],
      mobile_store_transactions: [],
      marketplace_orders: [{ id: 'm1', status: 'paid', amount_subunits: 5000, currency: 'USD', created_at: '2026-07-20T00:00:00.000Z' }],
      post_resource_bundle_orders: [],
      creator_resource_wallets: [{ available_token_subunits: 700, lifetime_earned_token_subunits: 900 }],
    });

    const report = await collectAdminRevenueReport(client, { now: NOW });

    expect(report.rails).toHaveLength(4);
    expect(report.rails.map((rail) => rail.grossSubunits)).toEqual([10000, 0, 5000, 0]);
    expect(report.creatorPayouts).toEqual({
      walletCount: 1,
      availableTokenSubunits: 700,
      lifetimeEarnedTokenSubunits: 900,
    });
  });

  it('leaves creditsIssued null on rails that do not issue credits', async () => {
    const client = createClient({
      transactions: [],
      mobile_store_transactions: [],
      marketplace_orders: [{ id: 'm1', status: 'paid', amount_subunits: 5000, currency: 'INR', created_at: '2026-07-20T00:00:00.000Z' }],
      post_resource_bundle_orders: [],
      creator_resource_wallets: [],
    });

    const report = await collectAdminRevenueReport(client, { now: NOW });

    expect(report.rails.find((rail) => rail.key === 'marketplace')?.creditsIssued).toBeNull();
  });
});
