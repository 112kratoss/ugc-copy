import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  status: 'created' | 'pending' | 'success' | string;
};

type OrderRow = {
  id: string;
  buyer_user_id: string;
  status: 'created' | 'paid' | string;
};

type HandlerResult = {
  handled: boolean;
  shouldRetry: boolean;
};

export type RazorpayWebhookRouteResult = {
  status: 200 | 500;
  body: string;
};

type RazorpayWebhookEvent = {
  event?: unknown;
  payload?: {
    payment?: {
      entity?: {
        id?: unknown;
        order_id?: unknown;
      };
    };
  };
};

type ProcessRazorpayWebhookParams = {
  createAdminSupabase: () => SupabaseClient;
  rawBody: string;
};

function parseWebhookEvent(rawBody: string): RazorpayWebhookEvent {
  const parsed = JSON.parse(rawBody) as unknown;
  return typeof parsed === 'object' && parsed !== null ? parsed as RazorpayWebhookEvent : {};
}

function isPaidStatus(row: { status?: unknown } | null): boolean {
  return row?.status === 'paid' || row?.status === 'success';
}

export async function processRazorpayWebhookForRoute({
  createAdminSupabase,
  rawBody,
}: ProcessRazorpayWebhookParams): Promise<RazorpayWebhookRouteResult> {
  const event = parseWebhookEvent(rawBody);
  let supabaseAdmin: SupabaseClient | null = null;

  function getSupabaseAdmin() {
    supabaseAdmin ??= createAdminSupabase();
    return supabaseAdmin;
  }

  async function handleCreditTransaction(orderId: string, paymentId: string): Promise<HandlerResult> {
    const { data: txn, error: txnError } = await getSupabaseAdmin()
      .from('transactions')
      .select('id, user_id, credits, status')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedTxn = (txn as CreditTransactionRow | null) ?? null;
    if (txnError) {
      console.error('Webhook: Failed to load credit transaction for order', orderId, txnError);
      return { handled: false, shouldRetry: false };
    }

    if (!typedTxn) {
      return { handled: false, shouldRetry: false };
    }

    if (typedTxn.status === 'success') {
      console.log('Webhook: Credit transaction already processed', orderId);
      return { handled: true, shouldRetry: false };
    }

    const { error: rpcError } = await getSupabaseAdmin().rpc('add_credits', {
      p_user_id: typedTxn.user_id,
      p_credits: typedTxn.credits,
      p_transaction_id: typedTxn.id,
      p_payment_id: paymentId,
    });

    if (rpcError) {
      console.error('Webhook: add_credits RPC failed', rpcError);
      return { handled: true, shouldRetry: true };
    }

    console.log(
      `Webhook: Credits assigned - user=${typedTxn.user_id}, credits=${typedTxn.credits}, order=${orderId}`
    );
    return { handled: true, shouldRetry: false };
  }

  async function handleMarketplaceOrder(orderId: string, paymentId: string): Promise<HandlerResult> {
    const { data: marketplaceOrder, error: marketplaceOrderError } = await getSupabaseAdmin()
      .from('marketplace_orders')
      .select('id, status, buyer_user_id')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedMarketplaceOrder = (marketplaceOrder as OrderRow | null) ?? null;
    if (marketplaceOrderError) {
      console.error('Webhook: Failed to load marketplace order for order', orderId, marketplaceOrderError);
      return { handled: false, shouldRetry: false };
    }

    if (!typedMarketplaceOrder) {
      return { handled: false, shouldRetry: false };
    }

    if (isPaidStatus(typedMarketplaceOrder)) {
      console.log('Webhook: Marketplace order already processed', orderId);
      return { handled: true, shouldRetry: false };
    }

    const { error: rpcError } = await getSupabaseAdmin().rpc('complete_marketplace_purchase', {
      p_razorpay_order_id: orderId,
      p_razorpay_payment_id: paymentId,
    });

    if (rpcError) {
      console.error('Webhook: complete_marketplace_purchase RPC failed', rpcError);
      return { handled: true, shouldRetry: true };
    }

    console.log(`Webhook: Marketplace purchase completed - buyer=${typedMarketplaceOrder.buyer_user_id}, order=${orderId}`);
    return { handled: true, shouldRetry: false };
  }

  async function handlePostResourceBundleOrder(orderId: string, paymentId: string): Promise<HandlerResult> {
    const { data: bundleOrder, error: bundleOrderError } = await getSupabaseAdmin()
      .from('post_resource_bundle_orders')
      .select('id, status, buyer_user_id')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedBundleOrder = (bundleOrder as OrderRow | null) ?? null;
    if (bundleOrderError) {
      console.error('Webhook: Failed to load post resource bundle order for order', orderId, bundleOrderError);
      return { handled: true, shouldRetry: true };
    }

    if (!typedBundleOrder) {
      return { handled: false, shouldRetry: false };
    }

    if (isPaidStatus(typedBundleOrder)) {
      console.log('Webhook: Post resource bundle order already processed', orderId);
      return { handled: true, shouldRetry: false };
    }

    const { data: completionResult, error: rpcError } = await getSupabaseAdmin().rpc(
      'complete_post_resource_bundle_purchase',
      {
        p_razorpay_order_id: orderId,
        p_razorpay_payment_id: paymentId,
      }
    );

    if (rpcError) {
      console.error('Webhook: complete_post_resource_bundle_purchase RPC failed', rpcError);
      return { handled: true, shouldRetry: true };
    }

    if (!completionResult) {
      const { data: refreshedOrder, error: refreshedOrderError } = await getSupabaseAdmin()
        .from('post_resource_bundle_orders')
        .select('status')
        .eq('razorpay_order_id', orderId)
        .maybeSingle();

      if (refreshedOrderError) {
        console.error('Webhook: Failed to reload post resource bundle order after completion attempt', orderId, refreshedOrderError);
        return { handled: true, shouldRetry: true };
      }

      if (isPaidStatus((refreshedOrder as { status?: unknown } | null) ?? null)) {
        console.log('Webhook: Post resource bundle order completed during concurrent verification', orderId);
        return { handled: true, shouldRetry: false };
      }

      console.error('Webhook: Post resource bundle order remained unresolved after completion attempt', orderId);
      return { handled: true, shouldRetry: true };
    }

    console.log(`Webhook: Post resource bundle purchase completed - buyer=${typedBundleOrder.buyer_user_id}, order=${orderId}`);
    return { handled: true, shouldRetry: false };
  }

  if (event.event !== 'payment.captured') {
    return { status: 200, body: 'OK' };
  }

  const payment = event.payload?.payment?.entity;
  if (!payment) {
    console.error('Webhook: Missing payment entity');
    return { status: 200, body: 'OK' };
  }

  const orderId = typeof payment.order_id === 'string' ? payment.order_id : '';
  const paymentId = typeof payment.id === 'string' ? payment.id : '';

  if (!orderId) {
    console.error('Webhook: Missing order_id in payment');
    return { status: 200, body: 'OK' };
  }

  const creditResult = await handleCreditTransaction(orderId, paymentId);
  if (creditResult.shouldRetry) {
    return { status: 500, body: 'Failed to assign credits' };
  }
  if (creditResult.handled) {
    return { status: 200, body: 'OK' };
  }

  const marketplaceResult = await handleMarketplaceOrder(orderId, paymentId);
  if (marketplaceResult.shouldRetry) {
    return { status: 500, body: 'Failed to finalize marketplace purchase' };
  }
  if (marketplaceResult.handled) {
    return { status: 200, body: 'OK' };
  }

  const bundleOrderResult = await handlePostResourceBundleOrder(orderId, paymentId);
  if (bundleOrderResult.shouldRetry) {
    return { status: 500, body: 'Failed to finalize post resource bundle purchase' };
  }
  if (bundleOrderResult.handled) {
    return { status: 200, body: 'OK' };
  }

  console.log('Webhook: No matching transaction, marketplace order, or post resource bundle order for order', orderId);
  return { status: 200, body: 'OK' };
}
