import 'server-only';
import { logBackendError, logBackendInfo } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  notifyReferralRewardSettlement,
  settleCreditPurchaseReferralRewards,
} from '@/lib/credit-referral-integration';
import { invalidateMarketplaceResourceListCache as defaultInvalidateMarketplaceResourceListCache } from '@/lib/marketplace-resource-list-cache';
import {
  RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
  recordPaymentWebhookProcessingFailure,
} from '@/lib/provider-dependency-telemetry';
import { verifyRazorpayPaymentAgainstOrder } from '@/lib/razorpay-payment-verification';
import {
  parseRazorpayPaymentResponse,
  RazorpayPaymentError,
  type RazorpayPaymentResponse,
} from '@/lib/razorpay-orders';
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
  amount_subunits: number;
  currency: string;
  razorpay_payment_id?: string | null;
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
        currency?: unknown;
        status?: unknown;
        captured?: unknown;
        notes?: unknown;
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
  invalidateMarketplaceResourceListCache?: () => void;
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
  invalidateMarketplaceResourceListCache = defaultInvalidateMarketplaceResourceListCache,
}: ProcessRazorpayWebhookParams): Promise<RazorpayWebhookRouteResult> {
  const event = parseWebhookEvent(rawBody);
  let supabaseAdmin: SupabaseClient | null = null;

  function getSupabaseAdmin() {
    supabaseAdmin ??= createAdminSupabase();
    return supabaseAdmin;
  }

  // Called wherever processing fails after signature verification and we ask
  // Razorpay to retry with a 500. Durable, so ops alerting does not depend on
  // ephemeral logs; recording failures are swallowed inside the helper.
  async function recordProcessingFailure(failureCode: string) {
    await recordPaymentWebhookProcessingFailure({
      serviceName: RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode,
    }, getSupabaseAdmin());
  }

  function isCapturedPaymentValid({
    buyerNoteKey,
    expectedAmount,
    expectedBuyerUserId,
    expectedCurrency,
    payment,
    purchaseKind,
  }: {
    buyerNoteKey: 'user_id' | 'buyer_user_id';
    expectedAmount: number;
    expectedBuyerUserId: string;
    expectedCurrency: string;
    payment: RazorpayPaymentResponse;
    purchaseKind: 'credits' | 'marketplace' | 'post_resource';
  }): boolean {
    const verification = verifyRazorpayPaymentAgainstOrder({
      payment,
      expectedPaymentId: payment.id,
      expectedOrderId: payment.orderId,
      expectedAmount,
      expectedCurrency,
      expectedBuyerUserId,
      buyerNoteKey,
    });
    if (verification.state !== 'captured') {
      logBackendError('razorpay_webhook_payment_validation_failed', {
        orderId: payment.orderId,
        purchaseKind,
        reason: verification.state === 'rejected'
          ? verification.reason
          : 'payment_not_captured',
      });
      return false;
    }

    return true;
  }

  async function handleCreditTransaction(payment: RazorpayPaymentResponse): Promise<HandlerResult> {
    const orderId = payment.orderId;
    const paymentId = payment.id;
    const { data: txn, error: txnError } = await getSupabaseAdmin()
      .from('transactions')
      .select('id, user_id, credits, amount, status, razorpay_payment_id, credit_effect_applied')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedTxn = (txn as CreditTransactionRow | null) ?? null;
    if (txnError) {
      // A transient DB read failure is indistinguishable from a matching order
      // we could not see; acknowledging with 200 would forfeit Razorpay's retry.
      logBackendError('razorpay_webhook_credit_transaction_load_failed', { orderId, error: txnError });
      return { handled: true, shouldRetry: true };
    }

    if (!typedTxn) {
      return { handled: false, shouldRetry: false };
    }

    if (typedTxn.status === 'failed' || typedTxn.status === 'refunded') {
      logBackendInfo('razorpay_webhook_credit_transaction_not_fulfillable', {
        orderId,
        status: typedTxn.status,
      });
      return { handled: true, shouldRetry: false };
    }

    if (
      !Number.isSafeInteger(typedTxn.amount)
      || !isCapturedPaymentValid({
        payment,
        expectedAmount: typedTxn.amount ?? -1,
        expectedCurrency: 'INR',
        expectedBuyerUserId: typedTxn.user_id,
        buyerNoteKey: 'user_id',
        purchaseKind: 'credits',
      })
    ) {
      return { handled: true, shouldRetry: false };
    }

    if (
      typedTxn.status === 'success'
      && typedTxn.razorpay_payment_id !== paymentId
    ) {
      logBackendError('razorpay_webhook_credit_payment_id_conflict', {
        orderId,
        transactionId: typedTxn.id,
      });
      return { handled: true, shouldRetry: false };
    }

    if (typedTxn.status === 'success') {
      logBackendInfo('razorpay_webhook_credit_transaction_already_processed', { orderId });
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
      logBackendError('razorpay_webhook_add_credits_failed', { orderId, error: rpcError });
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
        logBackendError('razorpay_webhook_credit_transaction_reload_failed', { orderId, error: refreshedError });
        return { handled: true, shouldRetry: true };
      }

      if (
        refreshed?.status !== 'success'
        || refreshed.credit_effect_applied !== true
        || refreshed.razorpay_payment_id !== paymentId
      ) {
        logBackendError('razorpay_webhook_credit_transaction_unresolved', { orderId });
        return { handled: true, shouldRetry: true };
      }

      logBackendInfo('razorpay_webhook_credit_transaction_settled_concurrently', { orderId });
    }

    await settleCreditPurchaseReferralRewards({
      adminSupabase: getSupabaseAdmin(),
      purchaserUserId: typedTxn.user_id,
      transactionId: typedTxn.id,
      source: 'razorpay_webhook',
    });

    logBackendInfo('razorpay_webhook_credits_assigned', {
      userId: typedTxn.user_id,
      credits: typedTxn.credits,
      orderId,
    });
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
    paymentId,
    providerEventId,
    reason,
    transaction,
  }: {
    action: 'reverse' | 'restore';
    cumulativeReversedSubunits: number;
    paymentId: string;
    providerEventId: string;
    reason: string;
    transaction: CreditTransactionRow;
  }): Promise<HandlerResult> {
    try {
      const settlement = await reconcileRazorpayCreditPurchaseAdjustment(getSupabaseAdmin(), {
        transactionId: transaction.id,
        providerEventId,
        paymentId,
        cumulativeReversedSubunits,
        action,
        reason,
      });
      await notifyReferralRewardSettlement(getSupabaseAdmin(), settlement);
      return { handled: true, shouldRetry: false };
    } catch (error) {
      logBackendError('razorpay_webhook_credit_adjustment_failed', { providerEventId, error });
      return { handled: true, shouldRetry: true };
    }
  }

  async function applyCommerceAdjustment({
    action,
    paymentId,
    providerOrderId,
    providerEventId,
    reason,
  }: {
    action: 'refund' | 'dispute' | 'restore';
    paymentId: string;
    providerOrderId: string;
    providerEventId: string;
    reason: string;
  }): Promise<HandlerResult> {
    const rpcNames = [
      'reconcile_marketplace_cash_adjustment',
      'reconcile_post_resource_cash_adjustment',
    ] as const;

    for (const rpcName of rpcNames) {
      const { data, error } = await getSupabaseAdmin().rpc(rpcName, {
        p_provider_event_id: providerEventId,
        p_payment_id: paymentId,
        p_provider_order_id: providerOrderId || null,
        p_action: action,
        p_reason: reason,
      });
      if (error) {
        logBackendError('razorpay_webhook_commerce_adjustment_failed', {
          action,
          paymentId,
          providerEventId,
          purchaseKind: rpcName === 'reconcile_marketplace_cash_adjustment'
            ? 'marketplace'
            : 'post_resource',
          error,
        });
        return { handled: true, shouldRetry: true };
      }

      const status = data && typeof data === 'object' && 'status' in data
        ? stringValue((data as { status?: unknown }).status)
        : '';
      if (status === 'not_found') {
        continue;
      }
      if (
        status === 'entitlement_missing'
        || status === 'order_conflict'
        || status === 'payment_conflict'
        || !status
      ) {
        logBackendError('razorpay_webhook_commerce_adjustment_unresolved', {
          action,
          paymentId,
          providerEventId,
          status: status || 'invalid_rpc_response',
        });
        return { handled: true, shouldRetry: true };
      }

      if (status === 'manual_review') {
        logBackendInfo('razorpay_webhook_commerce_restore_requires_manual_review', {
          paymentId,
          providerEventId,
        });
      }
      return { handled: true, shouldRetry: false };
    }

    return { handled: false, shouldRetry: false };
  }

  async function handleRefundProcessed(): Promise<HandlerResult> {
    const refund = event.payload?.refund?.entity;
    const payment = event.payload?.payment?.entity;
    const refundId = stringValue(refund?.id);
    const paymentId = stringValue(refund?.payment_id) || stringValue(payment?.id);
    const orderId = stringValue(payment?.order_id);
    const cumulativeRefunded = nonNegativeInteger(payment?.amount_refunded);

    if (!refundId || !paymentId) {
      logBackendError('razorpay_webhook_invalid_refund_payload');
      return { handled: true, shouldRetry: false };
    }

    let transaction: CreditTransactionRow | null;
    try {
      transaction = await loadCreditTransactionForAdjustment(paymentId, orderId);
    } catch (error) {
      logBackendError('razorpay_webhook_refunded_transaction_load_failed', { error });
      return { handled: true, shouldRetry: true };
    }
    if (!transaction) {
      return applyCommerceAdjustment({
        action: 'refund',
        paymentId,
        providerOrderId: orderId,
        providerEventId: `refund:${refundId}`,
        reason: 'razorpay_refund_processed',
      });
    }
    if (cumulativeRefunded === null) {
      logBackendError('razorpay_webhook_missing_credit_refund_total', { refundId });
      return { handled: true, shouldRetry: true };
    }
    if (!transaction.amount || cumulativeRefunded > transaction.amount) {
      logBackendError('razorpay_webhook_invalid_refund_amount', { refundId });
      return { handled: true, shouldRetry: false };
    }

    return applyCreditPurchaseAdjustment({
      action: 'reverse',
      cumulativeReversedSubunits: cumulativeRefunded,
      paymentId,
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
    const isReverseEvent = eventName === 'payment.dispute.created'
      || eventName === 'payment.dispute.action_required'
      || eventName === 'payment.dispute.under_review'
      || eventName === 'payment.dispute.lost'
      || eventName === 'payment.dispute.closed';
    if (!disputeId || !paymentId || disputeAmount === null || disputeAmount <= 0) {
      logBackendError('razorpay_webhook_invalid_dispute_payload', { eventName });
      return { handled: true, shouldRetry: false };
    }

    let transaction: CreditTransactionRow | null;
    try {
      transaction = await loadCreditTransactionForAdjustment(paymentId, orderId);
    } catch (error) {
      logBackendError('razorpay_webhook_disputed_transaction_load_failed', { error });
      return { handled: true, shouldRetry: true };
    }
    if (!transaction) {
      if (eventName === 'payment.dispute.won') {
        return applyCommerceAdjustment({
          action: 'restore',
          paymentId,
          providerOrderId: orderId,
          providerEventId: `dispute:${disputeId}:won`,
          reason: 'razorpay_dispute_won',
        });
      }
      if (isReverseEvent) {
        return applyCommerceAdjustment({
          action: 'dispute',
          paymentId,
          providerOrderId: orderId,
          providerEventId: `dispute:${disputeId}:reverse`,
          reason: 'razorpay_dispute_opened',
        });
      }
      return { handled: false, shouldRetry: false };
    }
    const amount = transaction.amount ?? 0;
    if (amount <= 0 || disputeAmount > amount || paymentRefunded > amount) {
      return { handled: true, shouldRetry: false };
    }

    const currentReversed = Math.max(0, transaction.credit_reversed_amount_subunits ?? 0);
    if (eventName === 'payment.dispute.won') {
      return applyCreditPurchaseAdjustment({
        action: 'restore',
        cumulativeReversedSubunits: Math.max(paymentRefunded, currentReversed - disputeAmount),
        paymentId,
        providerEventId: `dispute:${disputeId}:won`,
        reason: 'razorpay_dispute_won',
        transaction,
      });
    }

    if (isReverseEvent) {
      return applyCreditPurchaseAdjustment({
        action: 'reverse',
        cumulativeReversedSubunits: Math.min(
          amount,
          Math.max(currentReversed, paymentRefunded) + disputeAmount,
        ),
        paymentId,
        providerEventId: `dispute:${disputeId}:reverse`,
        reason: 'razorpay_dispute_opened',
        transaction,
      });
    }

    return { handled: true, shouldRetry: false };
  }

  async function handleMarketplaceOrder(payment: RazorpayPaymentResponse): Promise<HandlerResult> {
    const orderId = payment.orderId;
    const paymentId = payment.id;
    const { data: marketplaceOrder, error: marketplaceOrderError } = await getSupabaseAdmin()
      .from('marketplace_orders')
      .select('id, status, buyer_user_id, amount_subunits, currency, razorpay_payment_id')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedMarketplaceOrder = (marketplaceOrder as OrderRow | null) ?? null;
    if (marketplaceOrderError) {
      // Same retry semantics as the credit transaction load: a DB read error
      // must surface as a 500 so Razorpay redelivers the event.
      logBackendError('razorpay_webhook_marketplace_order_load_failed', { orderId, error: marketplaceOrderError });
      return { handled: true, shouldRetry: true };
    }

    if (!typedMarketplaceOrder) {
      return { handled: false, shouldRetry: false };
    }

    if (
      typedMarketplaceOrder.status === 'failed'
      || typedMarketplaceOrder.status === 'refunded'
    ) {
      logBackendInfo('razorpay_webhook_marketplace_order_not_fulfillable', {
        orderId,
        status: typedMarketplaceOrder.status,
      });
      return { handled: true, shouldRetry: false };
    }

    if (!isCapturedPaymentValid({
      payment,
      expectedAmount: typedMarketplaceOrder.amount_subunits,
      expectedCurrency: typedMarketplaceOrder.currency,
      expectedBuyerUserId: typedMarketplaceOrder.buyer_user_id,
      buyerNoteKey: 'buyer_user_id',
      purchaseKind: 'marketplace',
    })) {
      return { handled: true, shouldRetry: false };
    }
    if (
      isPaidStatus(typedMarketplaceOrder)
      && typedMarketplaceOrder.razorpay_payment_id !== paymentId
    ) {
      logBackendError('razorpay_webhook_marketplace_payment_id_conflict', {
        orderId,
        marketplaceOrderId: typedMarketplaceOrder.id,
      });
      return { handled: true, shouldRetry: false };
    }

    if (isPaidStatus(typedMarketplaceOrder)) {
      logBackendInfo('razorpay_webhook_marketplace_order_already_processed', { orderId });
      return { handled: true, shouldRetry: false };
    }

    const { data: completionResult, error: rpcError } = await getSupabaseAdmin().rpc('complete_marketplace_purchase', {
      p_razorpay_order_id: orderId,
      p_razorpay_payment_id: paymentId,
    });

    if (rpcError) {
      logBackendError('razorpay_webhook_marketplace_purchase_failed', { orderId, error: rpcError });
      return { handled: true, shouldRetry: true };
    }

    if (!completionResult) {
      const { data: refreshedOrder, error: refreshedOrderError } = await getSupabaseAdmin()
        .from('marketplace_orders')
        .select('status, razorpay_payment_id')
        .eq('razorpay_order_id', orderId)
        .maybeSingle();

      if (refreshedOrderError) {
        logBackendError('razorpay_webhook_marketplace_order_reload_failed', {
          orderId,
          error: refreshedOrderError,
        });
        return { handled: true, shouldRetry: true };
      }
      if (
        isPaidStatus((refreshedOrder as { status?: unknown } | null) ?? null)
        && refreshedOrder?.razorpay_payment_id === paymentId
      ) {
        logBackendInfo('razorpay_webhook_marketplace_order_completed_concurrently', { orderId });
        return { handled: true, shouldRetry: false };
      }
      if (refreshedOrder?.status === 'failed' || refreshedOrder?.status === 'refunded') {
        logBackendInfo('razorpay_webhook_marketplace_order_reversed_concurrently', { orderId });
        return { handled: true, shouldRetry: false };
      }

      logBackendError('razorpay_webhook_marketplace_order_unresolved', { orderId });
      return { handled: true, shouldRetry: true };
    }

    logBackendInfo('razorpay_webhook_marketplace_purchase_completed', { buyerUserId: typedMarketplaceOrder.buyer_user_id, orderId });
    return { handled: true, shouldRetry: false };
  }

  async function handlePostResourceBundleOrder(payment: RazorpayPaymentResponse): Promise<HandlerResult> {
    const orderId = payment.orderId;
    const paymentId = payment.id;
    const { data: bundleOrder, error: bundleOrderError } = await getSupabaseAdmin()
      .from('post_resource_bundle_orders')
      .select('id, status, buyer_user_id, amount_subunits, currency, razorpay_payment_id')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    const typedBundleOrder = (bundleOrder as OrderRow | null) ?? null;
    if (bundleOrderError) {
      logBackendError('razorpay_webhook_bundle_order_load_failed', { orderId, error: bundleOrderError });
      return { handled: true, shouldRetry: true };
    }

    if (!typedBundleOrder) {
      return { handled: false, shouldRetry: false };
    }

    if (typedBundleOrder.status === 'failed' || typedBundleOrder.status === 'refunded') {
      logBackendInfo('razorpay_webhook_bundle_order_not_fulfillable', {
        orderId,
        status: typedBundleOrder.status,
      });
      return { handled: true, shouldRetry: false };
    }

    if (!isCapturedPaymentValid({
      payment,
      expectedAmount: typedBundleOrder.amount_subunits,
      expectedCurrency: typedBundleOrder.currency,
      expectedBuyerUserId: typedBundleOrder.buyer_user_id,
      buyerNoteKey: 'buyer_user_id',
      purchaseKind: 'post_resource',
    })) {
      return { handled: true, shouldRetry: false };
    }
    if (
      isPaidStatus(typedBundleOrder)
      && typedBundleOrder.razorpay_payment_id !== paymentId
    ) {
      logBackendError('razorpay_webhook_bundle_payment_id_conflict', {
        orderId,
        resourceOrderId: typedBundleOrder.id,
      });
      return { handled: true, shouldRetry: false };
    }

    if (isPaidStatus(typedBundleOrder)) {
      logBackendInfo('razorpay_webhook_bundle_order_already_processed', { orderId });
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
      logBackendError('razorpay_webhook_bundle_purchase_failed', { orderId, error: rpcError });
      return { handled: true, shouldRetry: true };
    }

    if (!completionResult) {
      const { data: refreshedOrder, error: refreshedOrderError } = await getSupabaseAdmin()
        .from('post_resource_bundle_orders')
        .select('status, razorpay_payment_id')
        .eq('razorpay_order_id', orderId)
        .maybeSingle();

      if (refreshedOrderError) {
        logBackendError('razorpay_webhook_bundle_order_reload_failed', { orderId, error: refreshedOrderError });
        return { handled: true, shouldRetry: true };
      }

      if (
        isPaidStatus((refreshedOrder as { status?: unknown } | null) ?? null)
        && refreshedOrder?.razorpay_payment_id === paymentId
      ) {
        logBackendInfo('razorpay_webhook_bundle_order_completed_concurrently', { orderId });
        return { handled: true, shouldRetry: false };
      }
      if (refreshedOrder?.status === 'failed' || refreshedOrder?.status === 'refunded') {
        logBackendInfo('razorpay_webhook_bundle_order_reversed_concurrently', { orderId });
        return { handled: true, shouldRetry: false };
      }

      logBackendError('razorpay_webhook_bundle_order_unresolved', { orderId });
      return { handled: true, shouldRetry: true };
    }

    invalidateMarketplaceResourceListCache();

    logBackendInfo('razorpay_webhook_bundle_purchase_completed', { buyerUserId: typedBundleOrder.buyer_user_id, orderId });
    return { handled: true, shouldRetry: false };
  }

  if (event.event === 'refund.processed') {
    const result = await handleRefundProcessed();
    if (result.shouldRetry) {
      await recordProcessingFailure('payment_refund_reconciliation_failed');
      return { status: 500, body: 'Failed to reconcile payment refund' };
    }
    return { status: 200, body: 'OK' };
  }

  if (typeof event.event === 'string' && event.event.startsWith('payment.dispute.')) {
    const result = await handleDisputeEvent(event.event);
    if (result.shouldRetry) {
      await recordProcessingFailure('payment_dispute_reconciliation_failed');
      return { status: 500, body: 'Failed to reconcile payment dispute' };
    }
    return { status: 200, body: 'OK' };
  }

  if (event.event !== 'payment.captured') {
    return { status: 200, body: 'OK' };
  }

  const paymentEntity = event.payload?.payment?.entity;
  if (!paymentEntity) {
    logBackendError('razorpay_webhook_missing_payment_entity');
    return { status: 200, body: 'OK' };
  }

  let payment: RazorpayPaymentResponse;
  try {
    payment = parseRazorpayPaymentResponse(paymentEntity);
  } catch (error) {
    logBackendError('razorpay_webhook_invalid_captured_payment_entity', {
      error: error instanceof RazorpayPaymentError ? error.message : error,
    });
    return { status: 200, body: 'OK' };
  }

  const creditResult = await handleCreditTransaction(payment);
  if (creditResult.shouldRetry) {
    await recordProcessingFailure('credit_transaction_settlement_failed');
    return { status: 500, body: 'Failed to assign credits' };
  }
  if (creditResult.handled) {
    return { status: 200, body: 'OK' };
  }

  const marketplaceResult = await handleMarketplaceOrder(payment);
  if (marketplaceResult.shouldRetry) {
    await recordProcessingFailure('marketplace_purchase_settlement_failed');
    return { status: 500, body: 'Failed to finalize marketplace purchase' };
  }
  if (marketplaceResult.handled) {
    return { status: 200, body: 'OK' };
  }

  const bundleOrderResult = await handlePostResourceBundleOrder(payment);
  if (bundleOrderResult.shouldRetry) {
    await recordProcessingFailure('post_resource_bundle_settlement_failed');
    return { status: 500, body: 'Failed to finalize post resource bundle purchase' };
  }
  if (bundleOrderResult.handled) {
    return { status: 200, body: 'OK' };
  }

  logBackendInfo('razorpay_webhook_no_matching_order', { orderId: payment.orderId });
  return { status: 200, body: 'OK' };
}
