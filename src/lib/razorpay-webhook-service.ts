import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  notifyReferralRewardSettlement,
  settleCreditPurchaseReferralRewards,
} from '@/lib/credit-referral-integration';
import { reconcileRazorpayCreditPurchaseAdjustment } from '@/lib/referral-reward-service';

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  amount?: number;
  credit_reversed_amount_subunits?: number;
  credit_effect_applied?: boolean;
  razorpay_payment_id?: string | null;
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
        amount?: unknown;
        amount_refunded?: unknown;
      };
    };
    refund?: {
      entity?: {
        id?: unknown;
        payment_id?: unknown;
        amount?: unknown;
        status?: unknown;
      };
    };
    dispute?: {
      entity?: {
        id?: unknown;
        payment_id?: unknown;
        amount?: unknown;
        status?: unknown;
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

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
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
      .select('id, user_id, credits, status, razorpay_payment_id, credit_effect_applied')
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
      await settleCreditPurchaseReferralRewards({
        adminSupabase: getSupabaseAdmin(),
        purchaserUserId: typedTxn.user_id,
        transactionId: typedTxn.id,
        source: 'razorpay_webhook',
      });
      return { handled: true, shouldRetry: false };
    }

    const { data: rpcSuccess, error: rpcError } = await getSupabaseAdmin().rpc('add_credits', {
      p_user_id: typedTxn.user_id,
      p_credits: typedTxn.credits,
      p_transaction_id: typedTxn.id,
      p_payment_id: paymentId,
    });

    if (rpcError) {
      console.error('Webhook: add_credits RPC failed', rpcError);
      return { handled: true, shouldRetry: true };
    }

    if (!rpcSuccess) {
      const { data: refreshedTransaction, error: refreshedError } = await getSupabaseAdmin()
        .from('transactions')
        .select('id, status, razorpay_payment_id, credit_effect_applied')
        .eq('id', typedTxn.id)
        .maybeSingle();
      const refreshed = (refreshedTransaction as CreditTransactionRow | null) ?? null;

      if (refreshedError) {
        console.error('Webhook: Failed to reload credit transaction after add_credits returned false', refreshedError);
        return { handled: true, shouldRetry: true };
      }

      if (
        refreshed?.status !== 'success'
        || refreshed.credit_effect_applied !== true
        || refreshed.razorpay_payment_id !== paymentId
      ) {
        console.error('Webhook: Credit transaction remained unresolved after add_credits returned false', orderId);
        return { handled: true, shouldRetry: true };
      }

      console.log('Webhook: Credit transaction settled during concurrent verification', orderId);
    }

    await settleCreditPurchaseReferralRewards({
      adminSupabase: getSupabaseAdmin(),
      purchaserUserId: typedTxn.user_id,
      transactionId: typedTxn.id,
      source: 'razorpay_webhook',
    });

    console.log(
      `Webhook: Credits assigned - user=${typedTxn.user_id}, credits=${typedTxn.credits}, order=${orderId}`
    );
    return { handled: true, shouldRetry: false };
  }

  async function loadCreditTransactionForAdjustment(paymentId: string, orderId: string) {
    const select = 'id, user_id, credits, amount, status, razorpay_payment_id, credit_reversed_amount_subunits';
    if (paymentId) {
      const { data, error } = await getSupabaseAdmin()
        .from('transactions')
        .select(select)
        .eq('razorpay_payment_id', paymentId)
        .maybeSingle();
      if (error) throw error;
      if (data) return data as CreditTransactionRow;
    }

    if (orderId) {
      const { data, error } = await getSupabaseAdmin()
        .from('transactions')
        .select(select)
        .eq('razorpay_order_id', orderId)
        .maybeSingle();
      if (error) throw error;
      return (data as CreditTransactionRow | null) ?? null;
    }

    return null;
  }

  async function applyCreditPurchaseAdjustment({
    action,
    cumulativeReversedSubunits,
    providerEventId,
    reason,
    transaction,
  }: {
    action: 'reverse' | 'restore';
    cumulativeReversedSubunits: number;
    providerEventId: string;
    reason: string;
    transaction: CreditTransactionRow;
  }): Promise<HandlerResult> {
    try {
      const settlement = await reconcileRazorpayCreditPurchaseAdjustment(getSupabaseAdmin(), {
        transactionId: transaction.id,
        providerEventId,
        cumulativeReversedSubunits,
        action,
        reason,
      });
      await notifyReferralRewardSettlement(getSupabaseAdmin(), settlement);
      return { handled: true, shouldRetry: false };
    } catch (error) {
      console.error('Webhook: credit purchase adjustment failed', providerEventId, error);
      return { handled: true, shouldRetry: true };
    }
  }

  async function handleRefundProcessed(): Promise<HandlerResult> {
    const refund = event.payload?.refund?.entity;
    const payment = event.payload?.payment?.entity;
    const refundId = stringValue(refund?.id);
    const paymentId = stringValue(refund?.payment_id) || stringValue(payment?.id);
    const orderId = stringValue(payment?.order_id);
    const cumulativeRefunded = nonNegativeInteger(payment?.amount_refunded);

    if (!refundId || !paymentId || cumulativeRefunded === null) {
      console.error('Webhook: invalid refund.processed payload');
      return { handled: true, shouldRetry: false };
    }

    let transaction: CreditTransactionRow | null;
    try {
      transaction = await loadCreditTransactionForAdjustment(paymentId, orderId);
    } catch (error) {
      console.error('Webhook: failed to load refunded credit transaction', error);
      return { handled: true, shouldRetry: true };
    }
    if (!transaction) return { handled: false, shouldRetry: false };
    if (!transaction.amount || cumulativeRefunded > transaction.amount) {
      console.error('Webhook: invalid cumulative refund amount', refundId);
      return { handled: true, shouldRetry: false };
    }

    return applyCreditPurchaseAdjustment({
      action: 'reverse',
      cumulativeReversedSubunits: cumulativeRefunded,
      providerEventId: `refund:${refundId}`,
      reason: 'razorpay_refund_processed',
      transaction,
    });
  }

  async function handleDisputeEvent(eventName: string): Promise<HandlerResult> {
    const dispute = event.payload?.dispute?.entity;
    const payment = event.payload?.payment?.entity;
    const disputeId = stringValue(dispute?.id);
    const paymentId = stringValue(dispute?.payment_id) || stringValue(payment?.id);
    const orderId = stringValue(payment?.order_id);
    const disputeAmount = nonNegativeInteger(dispute?.amount);
    const paymentRefunded = nonNegativeInteger(payment?.amount_refunded) ?? 0;
    if (!disputeId || !paymentId || disputeAmount === null || disputeAmount <= 0) {
      console.error('Webhook: invalid dispute payload', eventName);
      return { handled: true, shouldRetry: false };
    }

    let transaction: CreditTransactionRow | null;
    try {
      transaction = await loadCreditTransactionForAdjustment(paymentId, orderId);
    } catch (error) {
      console.error('Webhook: failed to load disputed credit transaction', error);
      return { handled: true, shouldRetry: true };
    }
    if (!transaction) return { handled: false, shouldRetry: false };
    const amount = transaction.amount ?? 0;
    if (amount <= 0 || disputeAmount > amount || paymentRefunded > amount) {
      return { handled: true, shouldRetry: false };
    }

    const currentReversed = Math.max(0, transaction.credit_reversed_amount_subunits ?? 0);
    if (eventName === 'payment.dispute.won') {
      return applyCreditPurchaseAdjustment({
        action: 'restore',
        cumulativeReversedSubunits: Math.max(paymentRefunded, currentReversed - disputeAmount),
        providerEventId: `dispute:${disputeId}:won`,
        reason: 'razorpay_dispute_won',
        transaction,
      });
    }

    if (eventName === 'payment.dispute.created' || eventName === 'payment.dispute.action_required') {
      return applyCreditPurchaseAdjustment({
        action: 'reverse',
        cumulativeReversedSubunits: Math.min(
          amount,
          Math.max(currentReversed, paymentRefunded) + disputeAmount,
        ),
        providerEventId: `dispute:${disputeId}:reverse`,
        reason: 'razorpay_dispute_opened',
        transaction,
      });
    }

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

  if (event.event === 'refund.processed') {
    const result = await handleRefundProcessed();
    return result.shouldRetry
      ? { status: 500, body: 'Failed to reconcile credit refund' }
      : { status: 200, body: 'OK' };
  }

  if (typeof event.event === 'string' && event.event.startsWith('payment.dispute.')) {
    const result = await handleDisputeEvent(event.event);
    return result.shouldRetry
      ? { status: 500, body: 'Failed to reconcile credit dispute' }
      : { status: 200, body: 'OK' };
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
