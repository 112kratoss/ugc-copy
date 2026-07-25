import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

const MARKETPLACE_SALES_CSV_HEADER = 'asset_title,buyer_user_id,price_usd,amount_paid,currency,purchased_at,order_id';

type MarketplaceAssetExportRow = {
  id?: unknown;
  title?: unknown;
};

type MarketplacePurchaseExportRow = {
  asset_id?: unknown;
  buyer_user_id?: unknown;
  price_usd_cents?: unknown;
  amount_subunits?: unknown;
  currency?: unknown;
  created_at?: unknown;
  order_id?: unknown;
};

export type MarketplaceSalesExportRouteResult =
  | {
      ok: true;
      csv: string;
    }
  | {
      ok: false;
      status: 500;
      body: 'Failed to load listings' | 'Failed to load sales';
    };

function escapeCsvValue(value: string | number): string {
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function createAssetTitleMap(assets: MarketplaceAssetExportRow[]) {
  return new Map(
    assets
      .filter((row): row is { id: string; title?: unknown } => typeof row.id === 'string')
      .map((row) => [row.id, typeof row.title === 'string' ? row.title : undefined])
  );
}

function renderPurchaseLine(
  row: MarketplacePurchaseExportRow,
  assetMap: Map<string, string | undefined>,
) {
  return [
    escapeCsvValue(assetMap.get(toStringValue(row.asset_id)) ?? 'Untitled listing'),
    escapeCsvValue(toStringValue(row.buyer_user_id)),
    escapeCsvValue((toNumber(row.price_usd_cents) / 100).toFixed(2)),
    escapeCsvValue(toNumber(row.amount_subunits) / 100),
    escapeCsvValue(toStringValue(row.currency)),
    escapeCsvValue(toStringValue(row.created_at)),
    escapeCsvValue(toStringValue(row.order_id)),
  ].join(',');
}

export async function exportMarketplaceSalesForRoute({
  adminSupabase,
  sellerUserId,
}: {
  adminSupabase: SupabaseClient;
  sellerUserId: string;
}): Promise<MarketplaceSalesExportRouteResult> {
  const { data: assets, error: assetsError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, title')
    .eq('seller_user_id', sellerUserId)
    .neq('status', 'deleted');

  if (assetsError) {
    logBackendError('failed_to_load_seller_assets_for_export', { error: assetsError });
    return { ok: false, status: 500, body: 'Failed to load listings' };
  }

  const assetMap = createAssetTitleMap((assets ?? []) as MarketplaceAssetExportRow[]);

  if (assetMap.size === 0) {
    return {
      ok: true,
      csv: `${MARKETPLACE_SALES_CSV_HEADER}\n`,
    };
  }

  const { data: purchases, error: purchasesError } = await adminSupabase
    .from('marketplace_purchases')
    .select('asset_id, buyer_user_id, price_usd_cents, amount_subunits, currency, created_at, order_id')
    .in('asset_id', Array.from(assetMap.keys()))
    .order('created_at', { ascending: false });

  if (purchasesError) {
    logBackendError('failed_to_load_seller_purchases_for_export', { error: purchasesError });
    return { ok: false, status: 500, body: 'Failed to load sales' };
  }

  return {
    ok: true,
    csv: [
      MARKETPLACE_SALES_CSV_HEADER,
      ...((purchases ?? []) as MarketplacePurchaseExportRow[]).map((row) => renderPurchaseLine(row, assetMap)),
    ].join('\n'),
  };
}
