import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { exportMarketplaceSalesForRoute } from '@/lib/marketplace-sales-export-service';

function createMarketplaceSalesExportClient(options?: {
  assets?: Array<Record<string, unknown>> | null;
  assetsError?: { message: string } | null;
  purchases?: Array<Record<string, unknown>> | null;
  purchasesError?: { message: string } | null;
}) {
  const calls = {
    tables: [] as string[],
    filters: [] as Array<{ table: string; method: string; args: unknown[] }>,
  };

  function createAssetsQuery() {
    const query = {
      select(columns: string) {
        calls.filters.push({ table: 'marketplace_assets', method: 'select', args: [columns] });
        return query;
      },
      eq(column: string, value: unknown) {
        calls.filters.push({ table: 'marketplace_assets', method: 'eq', args: [column, value] });
        return query;
      },
      neq(column: string, value: unknown) {
        calls.filters.push({ table: 'marketplace_assets', method: 'neq', args: [column, value] });
        return Promise.resolve({
          data: options?.assets === undefined ? [] : options.assets,
          error: options?.assetsError ?? null,
        });
      },
    };

    return query;
  }

  function createPurchasesQuery() {
    const query = {
      select(columns: string) {
        calls.filters.push({ table: 'marketplace_purchases', method: 'select', args: [columns] });
        return query;
      },
      in(column: string, value: unknown[]) {
        calls.filters.push({ table: 'marketplace_purchases', method: 'in', args: [column, value] });
        return query;
      },
      order(column: string, optionsArg: Record<string, unknown>) {
        calls.filters.push({ table: 'marketplace_purchases', method: 'order', args: [column, optionsArg] });
        return Promise.resolve({
          data: options?.purchases ?? [],
          error: options?.purchasesError ?? null,
        });
      },
    };

    return query;
  }

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table === 'marketplace_assets') return createAssetsQuery();
      if (table === 'marketplace_purchases') return createPurchasesQuery();
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    calls,
    client: client as unknown as SupabaseClient,
  };
}

describe('exportMarketplaceSalesForRoute', () => {
  it('returns header-only CSV when the seller has no listings without loading purchases', async () => {
    const admin = createMarketplaceSalesExportClient();

    const result = await exportMarketplaceSalesForRoute({
      adminSupabase: admin.client,
      sellerUserId: 'seller-1',
    });

    expect(result).toEqual({
      ok: true,
      csv: 'asset_title,buyer_user_id,price_usd,amount_paid,currency,purchased_at,order_id\n',
    });
    expect(admin.calls.tables).toEqual(['marketplace_assets']);
    expect(admin.calls.filters).toContainEqual({
      table: 'marketplace_assets',
      method: 'eq',
      args: ['seller_user_id', 'seller-1'],
    });
    expect(admin.calls.filters).toContainEqual({
      table: 'marketplace_assets',
      method: 'neq',
      args: ['status', 'deleted'],
    });
  });

  it('escapes CSV values and formats seller purchases for export', async () => {
    const admin = createMarketplaceSalesExportClient({
      assets: [
        { id: 'asset-1', title: 'Fancy "Pack", Deluxe' },
        { id: 'asset-2' },
        { id: 123, title: 'ignored invalid id' },
      ],
      purchases: [
        {
          asset_id: 'asset-1',
          buyer_user_id: 'buyer-1',
          price_usd_cents: 1234,
          amount_subunits: 999,
          currency: 'USD',
          created_at: '2026-06-23T00:00:00.000Z',
          order_id: 'order\n1',
        },
        {
          asset_id: 'asset-2',
          buyer_user_id: 'buyer-2',
          price_usd_cents: 0,
          amount_subunits: 0,
          currency: 'INR',
          created_at: '2026-06-23T01:00:00.000Z',
          order_id: 'order-2',
        },
      ],
    });

    const result = await exportMarketplaceSalesForRoute({
      adminSupabase: admin.client,
      sellerUserId: 'seller-1',
    });

    expect(result).toEqual({
      ok: true,
      csv: [
        'asset_title,buyer_user_id,price_usd,amount_paid,currency,purchased_at,order_id',
        '"Fancy ""Pack"", Deluxe",buyer-1,12.34,9.99,USD,2026-06-23T00:00:00.000Z,"order\n1"',
        'Untitled listing,buyer-2,0.00,0,INR,2026-06-23T01:00:00.000Z,order-2',
      ].join('\n'),
    });
    expect(admin.calls.filters).toContainEqual({
      table: 'marketplace_purchases',
      method: 'in',
      args: ['asset_id', ['asset-1', 'asset-2']],
    });
    expect(admin.calls.filters).toContainEqual({
      table: 'marketplace_purchases',
      method: 'order',
      args: ['created_at', { ascending: false }],
    });
  });

  it('maps listing load failures to stable export errors', async () => {
    const admin = createMarketplaceSalesExportClient({
      assetsError: { message: 'database unavailable' },
    });

    const result = await exportMarketplaceSalesForRoute({
      adminSupabase: admin.client,
      sellerUserId: 'seller-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: 'Failed to load listings',
    });
  });

  it('maps purchase load failures to stable export errors', async () => {
    const admin = createMarketplaceSalesExportClient({
      assets: [{ id: 'asset-1', title: 'Asset' }],
      purchasesError: { message: 'database unavailable' },
    });

    const result = await exportMarketplaceSalesForRoute({
      adminSupabase: admin.client,
      sellerUserId: 'seller-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: 'Failed to load sales',
    });
  });
});
