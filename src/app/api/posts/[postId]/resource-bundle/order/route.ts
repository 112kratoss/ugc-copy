import { NextRequest, NextResponse } from 'next/server';
import Razorpay from 'razorpay';

import {
  getBundleForOrderByPostId,
  getPostResourceBundlePriceQuote,
} from '@/lib/post-resource-bundles-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

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
  return `bundle_${userId.slice(0, 8)}_${Date.now()}`;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminSupabase = createServiceClient();
  const body = await request.json() as {
    locale?: string | null;
  };

  const bundle = await getBundleForOrderByPostId(postId);
  if (!bundle || bundle.status !== 'published') {
    return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
  }

  if (bundle.owner_user_id === user.id) {
    return NextResponse.json({ error: 'You already own this unlock.' }, { status: 400 });
  }

  const { data: existingPurchase } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('bundle_id', bundle.id)
    .eq('buyer_user_id', user.id)
    .maybeSingle();

  if (existingPurchase) {
    return NextResponse.json({ success: true, alreadyPurchased: true });
  }

  if (bundle.access_mode === 'free' || bundle.price_usd_cents === 0) {
    return NextResponse.json({ error: 'Use the free unlock endpoint for this bundle.' }, { status: 400 });
  }

  const countryCode =
    request.headers.get('x-vercel-ip-country')?.toUpperCase()
    ?? inferCountryFromLocale(typeof body.locale === 'string' ? body.locale : null);
  const priceQuote = await getPostResourceBundlePriceQuote(bundle.price_usd_cents, countryCode);
  const amount = priceQuote.amountSubunits;
  const currency = priceQuote.currency;
  const displayPrice = priceQuote.formatted;
  const note = priceQuote.note;

  const razorpay = new Razorpay({
    key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID as string,
    key_secret: process.env.RAZORPAY_KEY_SECRET as string,
  });

  const razorpayOrder = await razorpay.orders.create({
    amount,
    currency,
    receipt: buildReceipt(user.id),
    notes: {
      bundle_id: bundle.id,
      buyer_user_id: user.id,
      post_id: postId,
    },
  });

  if (!razorpayOrder?.id) {
    return NextResponse.json({ error: 'Failed to create Razorpay order.' }, { status: 500 });
  }

  const { error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .insert({
      bundle_id: bundle.id,
      buyer_user_id: user.id,
      razorpay_order_id: razorpayOrder.id,
      amount_subunits: amount,
      currency,
      status: 'created',
    });

  if (orderError) {
    console.error('Failed to record bundle order:', orderError);
    return NextResponse.json({ error: 'Failed to record order.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    postId,
    bundleId: bundle.id,
    orderId: razorpayOrder.id,
    amount,
    currency,
    displayPrice,
    note,
    bundleTitle: bundle.title,
  });
}
