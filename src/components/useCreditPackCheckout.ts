import { useEffect, useRef, useState } from 'react';

import type { PricingPlanId } from '@/lib/pricing';
import {
  clearRazorpayCheckoutIntentKey,
  getOrCreateRazorpayCheckoutIntentKey,
  pollCreditBalanceAfterPayment,
  verifyRazorpayCheckoutUntilSettled,
  type RazorpayCheckoutVerificationResult,
} from '@/lib/razorpay-checkout-client';
import { supabase } from '@/lib/supabase';

/**
 * What a checkout says, under the pack that started it. After the sheet reports a payment the
 * money is taken, so from `confirming` on no state may read as a failure or invite a second
 * payment: Razorpay's webhook settles the order even when the page cannot.
 */
export type CreditCheckoutStatus =
  | { planId: PricingPlanId; kind: 'confirming' | 'settled' | 'pending' | 'paid' }
  | { planId: PricingPlanId; kind: 'failed'; message: string };

export const CREDIT_CHECKOUT_STATUS_COPY = {
  confirming: 'Confirming your payment…',
  settled: 'Payment successful! Credits added to your account.',
  pending: 'Payment received and waiting for capture. Your credits will appear automatically once Razorpay confirms it.',
  paid: 'Your payment went through and your credits will appear in your balance shortly. You do not need to pay again.',
} as const;

// What Razorpay's `payment.failed` says went wrong, when it says anything.
function paymentFailureDescription(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const description = (error as { description?: unknown }).description;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

/**
 * A credit pack bought through Razorpay's sheet, as the pricing page and the creators' top-up
 * sheet (`CreditTopUpSheet`) buy it: one copy, moved out of the pricing page (2026-11-02) when
 * the creators came to sell packs in place. The server prices the order from the pack's id and
 * settles it on verify, or by its webhook when this page cannot; the page only asks.
 *
 * The checkout script (`https://checkout.razorpay.com/v1/checkout.js`) is the caller's to load.
 */
export function useCreditPackCheckout({ onSignedOut, onBuyer }: {
  /** No session at the press: the caller sends the visitor to sign in. */
  onSignedOut: () => void;
  /** The account the press buys for, read from the session at the press. */
  onBuyer?: (userId: string) => void;
}) {
  const [loadingPlan, setLoadingPlan] = useState<PricingPlanId | null>(null);
  const [status, setStatus] = useState<CreditCheckoutStatus | null>(null);
  const stopBalanceRefreshRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    stopBalanceRefreshRef.current?.();
    stopBalanceRefreshRef.current = null;
  }, []);

  const refreshBalanceForAMinute = () => {
    stopBalanceRefreshRef.current?.();
    stopBalanceRefreshRef.current = pollCreditBalanceAfterPayment();
  };

  // Read right before each verify attempt, not at the click: the buyer can
  // spend minutes in the sheet, long enough for that token to expire.
  const readAccessToken = async () => {
    const { data: { session: current } } = await supabase.auth.getSession();
    if (!current?.access_token) {
      throw new Error('The session ended while the payment was being made.');
    }
    return current.access_token;
  };

  const buy = async (planId: PricingPlanId) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      onSignedOut();
      return;
    }
    const buyerId = session.user.id;
    onBuyer?.(buyerId);
    setStatus(null);
    const checkoutIntentScope = `credits:${planId}`;

    try {
      setLoadingPlan(planId);

      const token = session.access_token;

      if (!token) {
        throw new Error('Authentication token not found. Please log in again.');
      }

      const clientIntentKey = getOrCreateRazorpayCheckoutIntentKey(checkoutIntentScope);
      const orderRes = await fetch('/api/razorpay/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ planId, userId: buyerId, clientIntentKey }),
      });

      const orderData = await orderRes.json().catch(() => ({}));

      if (!orderRes.ok) {
        if (orderData.code === 'CHECKOUT_PAYLOAD_MISMATCH') {
          clearRazorpayCheckoutIntentKey(checkoutIntentScope);
        }
        throw new Error(orderData.error || 'Failed to create order');
      }

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'magicbooklet',
        description: `Purchase ${planId} credits`,
        order_id: orderData.orderId,
        handler: async function (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
          // The sheet has taken the money; from here on, nothing says "try again".
          setStatus({ planId, kind: 'confirming' });
          let verification: RazorpayCheckoutVerificationResult;
          try {
            verification = await verifyRazorpayCheckoutUntilSettled({
              url: '/api/razorpay/verify',
              token: readAccessToken,
              body: {
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                userId: buyerId,
              },
            });
          } catch (err) {
            console.error('Verification error:', err);
            // A dropped network, a timeout, a 5xx or an expired token
            // after payment: the webhook settles this order, and the
            // intent key would replay the paid order on the next try.
            clearRazorpayCheckoutIntentKey(checkoutIntentScope);
            setStatus({ planId, kind: 'paid' });
            refreshBalanceForAMinute();
            return;
          }

          // The payment is now bound to this provider order. Credits are
          // repeat-purchasable, so do not pin the next checkout to an
          // order that is (or may become) paid.
          clearRazorpayCheckoutIntentKey(checkoutIntentScope);
          if (verification.state === 'pending') {
            // The webhook owns final settlement.
            setStatus({ planId, kind: 'pending' });
            refreshBalanceForAMinute();
            return;
          }

          setStatus({ planId, kind: 'settled' });
          // AuthProvider and the header re-read `profiles.credits` on this.
          window.dispatchEvent(new Event('credits_updated'));
        },
        theme: {
          color: '#ff7a59',
        },
      };

      const Razorpay = window.Razorpay;
      if (typeof Razorpay !== 'function') {
        throw new Error('Checkout is still loading. Try again in a moment.');
      }
      const rzp = new Razorpay(options);

      // A failed attempt took no money, and the sheet stays open for another.
      rzp.on('payment.failed', function (failure: unknown) {
        const description = paymentFailureDescription(failure);
        console.error('Payment failed:', description ?? failure);
        setStatus({
          planId,
          kind: 'failed',
          message: `Payment failed: ${description ?? 'Please try again.'}`,
        });
      });

      rzp.open();

    } catch (error: unknown) {
      console.error('Payment initiation error:', error);
      setStatus({
        planId,
        kind: 'failed',
        message: error instanceof Error ? error.message : 'An error occurred while initiating payment.',
      });
    } finally {
      setLoadingPlan(null);
    }
  };

  return { buy, loadingPlan, status };
}
