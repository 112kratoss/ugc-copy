import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { notifyPostResourceUnlockCompleted } from '@/lib/mobile-notifications';
import { getBundleForOrderByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const adminSupabase = createServiceClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bundle = await getBundleForOrderByPostId(postId);
  if (!bundle || bundle.status !== 'published') {
    return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
  }

  if (bundle.owner_user_id === user.id) {
    return NextResponse.json({ success: true, alreadyPurchased: true });
  }

  if (bundle.access_mode !== 'free' || bundle.price_usd_cents !== 0) {
    return NextResponse.json({ error: 'This bundle requires payment.' }, { status: 400 });
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

  const freeOrderId = `free_bundle_${randomUUID()}`;
  const { error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .insert({
      bundle_id: bundle.id,
      buyer_user_id: user.id,
      razorpay_order_id: freeOrderId,
      razorpay_payment_id: `free_${randomUUID()}`,
      amount_subunits: 0,
      currency: 'USD',
      status: 'created',
    });

  if (orderError) {
    console.error('Failed to create free bundle order:', orderError);
    return NextResponse.json({ error: 'Failed to open the free unlock.' }, { status: 500 });
  }

  const { data: completed, error: completionError } = await adminSupabase.rpc('complete_post_resource_bundle_purchase', {
    p_razorpay_order_id: freeOrderId,
    p_razorpay_payment_id: `free_unlock_${randomUUID()}`,
  });

  if (completionError) {
    console.error('Failed to complete free bundle unlock:', completionError);
    return NextResponse.json({ error: 'Failed to open the free unlock.' }, { status: 500 });
  }

  await notifyPostResourceUnlockCompleted(adminSupabase, {
    buyerUserId: user.id,
    ownerUserId: bundle.owner_user_id,
    postId,
    bundleId: bundle.id,
    alreadyProcessed: !completed,
  });

  return NextResponse.json({
    success: true,
    free: true,
    alreadyProcessed: !completed,
  });
}
