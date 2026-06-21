import { NextRequest } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';

function escapeCsvValue(value: string | number): string {
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export async function GET(request: NextRequest) {
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const adminSupabase = createServiceClient();
  const { data: assets, error: assetsError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, title')
    .eq('seller_user_id', user.id)
    .neq('status', 'deleted');

  if (assetsError) {
    console.error('Failed to load seller assets for export:', assetsError);
    return new Response('Failed to load listings', { status: 500 });
  }

  const assetMap = new Map(
    (assets ?? [])
      .filter((row): row is { id: string; title: string } => typeof row.id === 'string')
      .map((row) => [row.id, row.title])
  );

  if (assetMap.size === 0) {
    return new Response('asset_title,buyer_user_id,price_usd,amount_paid,currency,purchased_at,order_id\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="marketplace-sales.csv"',
      },
    });
  }

  const { data: purchases, error: purchasesError } = await adminSupabase
    .from('marketplace_purchases')
    .select('asset_id, buyer_user_id, price_usd_cents, amount_subunits, currency, created_at, order_id')
    .in('asset_id', Array.from(assetMap.keys()))
    .order('created_at', { ascending: false });

  if (purchasesError) {
    console.error('Failed to load seller purchases for export:', purchasesError);
    return new Response('Failed to load sales', { status: 500 });
  }

  const header = 'asset_title,buyer_user_id,price_usd,amount_paid,currency,purchased_at,order_id';
  const lines = (purchases ?? []).map((row) => [
    escapeCsvValue(assetMap.get(row.asset_id as string) ?? 'Untitled listing'),
    escapeCsvValue(row.buyer_user_id as string),
    escapeCsvValue(((row.price_usd_cents as number) / 100).toFixed(2)),
    escapeCsvValue((row.amount_subunits as number) / 100),
    escapeCsvValue(row.currency as string),
    escapeCsvValue(row.created_at as string),
    escapeCsvValue(row.order_id as string),
  ].join(','));

  return new Response([header, ...lines].join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="marketplace-sales.csv"',
    },
  });
}
