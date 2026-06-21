import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';

import { getMarketplacePriceQuote } from '@/lib/marketplace-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

interface MarketplaceOrderAssetRow {
  id: string;
  title: string;
  price_usd_cents: number;
  status: 'draft' | 'active' | 'unlisted' | 'deleted';
  seller_user_id: string;
}

function inferCountryFromLocale(locale: string | null): string | null {
  if (!locale) {
    return null;
  }

  try {
    const parsed = new Intl.Locale(locale);
    return parsed.region?.toUpperCase() ?? null;
  } catch {
    const match = locale.match(/-([A-Za-z]{2})\b/);
    return match ? match[1].toUpperCase() : null;
  }
}

function buildReceipt(userId: string) {
  return `mkt_${userId.slice(0, 8)}_${Date.now()}`;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = createServiceClient();
    const body = await request.json();
    const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
    const clientLocale = typeof body.locale === 'string' ? body.locale.trim() : null;

    if (!assetId) {
      return NextResponse.json({ error: 'Missing asset ID.' }, { status: 400 });
    }

    const { data: assetData, error: assetError } = await adminSupabase
      .from('marketplace_assets')
      .select('id, title, price_usd_cents, status, seller_user_id')
      .eq('id', assetId)
      .maybeSingle();

    if (assetError) {
      console.error('Failed to load marketplace asset for order:', assetError);
      return NextResponse.json({ error: 'Failed to load listing.' }, { status: 500 });
    }

    const asset = (assetData as MarketplaceOrderAssetRow | null) ?? null;
    if (!asset || (asset.status !== 'active' && asset.status !== 'unlisted')) {
      return NextResponse.json({ error: 'Listing not found.' }, { status: 404 });
    }

    if (asset.seller_user_id === user.id) {
      return NextResponse.json({ error: 'You already own this listing.' }, { status: 400 });
    }

    const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
      .from('marketplace_purchases')
      .select('asset_id')
      .eq('asset_id', assetId)
      .eq('buyer_user_id', user.id)
      .maybeSingle();

    if (existingPurchaseError) {
      console.error('Failed to check existing purchase:', existingPurchaseError);
      return NextResponse.json({ error: 'Failed to check purchase history.' }, { status: 500 });
    }

    if (existingPurchase) {
      return NextResponse.json({ success: true, alreadyPurchased: true });
    }

    if (asset.price_usd_cents === 0) {
      const freeOrderId = `free_${randomUUID()}`;
      const { error: orderError } = await adminSupabase
        .from('marketplace_orders')
        .insert({
          asset_id: assetId,
          buyer_user_id: user.id,
          razorpay_order_id: freeOrderId,
          razorpay_payment_id: `free_${randomUUID()}`,
          amount_subunits: 0,
          currency: 'USD',
          status: 'created',
        });

      if (orderError) {
        console.error('Failed to create free marketplace order:', orderError);
        return NextResponse.json({ error: 'Failed to unlock free listing.' }, { status: 500 });
      }

      const { data: completed, error: completionError } = await adminSupabase.rpc('complete_marketplace_purchase', {
        p_razorpay_order_id: freeOrderId,
        p_razorpay_payment_id: `free_unlock_${randomUUID()}`,
      });

      if (completionError) {
        console.error('Failed to complete free marketplace purchase:', completionError);
        return NextResponse.json({ error: 'Failed to unlock free listing.' }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        free: true,
        alreadyProcessed: !completed,
      });
    }

    const countryCode =
      request.headers.get('x-vercel-ip-country')?.toUpperCase()
      ?? inferCountryFromLocale(clientLocale);
    const priceQuote = await getMarketplacePriceQuote(asset.price_usd_cents, countryCode);

    const razorpay = new Razorpay({
      key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID as string,
      key_secret: process.env.RAZORPAY_KEY_SECRET as string,
    });

    const razorpayOrder = await razorpay.orders.create({
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      receipt: buildReceipt(user.id),
      notes: {
        asset_id: asset.id,
        buyer_user_id: user.id,
      },
    });

    if (!razorpayOrder?.id) {
      return NextResponse.json({ error: 'Failed to create Razorpay order.' }, { status: 500 });
    }

    const { error: orderInsertError } = await adminSupabase
      .from('marketplace_orders')
      .insert({
        asset_id: asset.id,
        buyer_user_id: user.id,
        razorpay_order_id: razorpayOrder.id,
        amount_subunits: priceQuote.amountSubunits,
        currency: priceQuote.currency,
        status: 'created',
      });

    if (orderInsertError) {
      console.error('Failed to record marketplace order:', orderInsertError);
      return NextResponse.json({ error: 'Failed to record order.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      assetId: asset.id,
      orderId: razorpayOrder.id,
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      displayPrice: priceQuote.formatted,
      note: priceQuote.note,
      listingTitle: asset.title,
    });
  } catch (error) {
    console.error('Marketplace order creation failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
