import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';

interface MarketplaceOrderRow {
  id: string;
  buyer_user_id: string;
  status: 'created' | 'paid' | 'failed';
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
    const razorpayOrderId = typeof body.razorpay_order_id === 'string' ? body.razorpay_order_id.trim() : '';
    const razorpayPaymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id.trim() : '';
    const razorpaySignature = typeof body.razorpay_signature === 'string' ? body.razorpay_signature.trim() : '';

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return NextResponse.json({ error: 'Missing required payment parameters.' }, { status: 400 });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      return NextResponse.json({ error: 'Invalid payment signature.' }, { status: 400 });
    }

    const { data: orderData, error: orderError } = await adminSupabase
      .from('marketplace_orders')
      .select('id, buyer_user_id, status')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();

    if (orderError) {
      console.error('Failed to load marketplace order for verification:', orderError);
      return NextResponse.json({ error: 'Failed to verify order.' }, { status: 500 });
    }

    const order = (orderData as MarketplaceOrderRow | null) ?? null;
    if (!order || order.buyer_user_id !== user.id) {
      return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
    }

    if (order.status === 'paid') {
      return NextResponse.json({ success: true, alreadyProcessed: true });
    }

    const { data: completionResult, error: completionError } = await adminSupabase.rpc('complete_marketplace_purchase', {
      p_razorpay_order_id: razorpayOrderId,
      p_razorpay_payment_id: razorpayPaymentId,
    });

    if (completionError) {
      console.error('Failed to complete marketplace purchase:', completionError);
      return NextResponse.json({ error: 'Failed to complete purchase.' }, { status: 500 });
    }

    if (!completionResult) {
      const { data: refreshedOrder } = await adminSupabase
        .from('marketplace_orders')
        .select('status')
        .eq('razorpay_order_id', razorpayOrderId)
        .maybeSingle();

      if (refreshedOrder?.status === 'paid') {
        return NextResponse.json({ success: true, alreadyProcessed: true });
      }

      return NextResponse.json({ error: 'Unable to finalize purchase.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Marketplace payment verification failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
