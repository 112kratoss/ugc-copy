import { useEffect, useRef, useState } from 'react';

import type { PricingPlanId } from '@/lib/pricing';
import {
  clearRazorpayCheckoutIntentKey,
  getOrCreateRazorpayCheckoutIntentKey,
  loadRazorpayCheckout,
  pollCreditBalanceAfterPayment,
  readCheckoutAccessToken,
  verifyRazorpayCheckoutUntilSettled,
  type RazorpayCheckoutVerificationResult,
} from '@/lib/razorpay-checkout-client';
import { supabase } from '@/lib/supabase';

/** The id checkout.js is loaded under where packs are sold (`loadRazorpayCheckout` owns the tag). */
const CREDIT_CHECKOUT_SCRIPT_ID = 'razorpay-checkout-js';

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
 * checkout.js is fetched as the checkout mounts, and a press made before it has arrived waits for it.
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

  // Fetched as the packs show, so a press seldom waits; one that fails is fetched again by the press.
  useEffect(() => {
    void loadRazorpayCheckout(CREDIT_CHECKOUT_SCRIPT_ID).catch(() => undefined);
  }, []);

  // The poll outlives whatever drew the checkout, and stops itself after its minute: it only
  // asks the page to read the balance again. The creators' sheet goes as soon as the buyer is
  // done with it ("Back to your run"), which is when a payment still capturing settles; stopped
  // with the sheet, the bar kept "Not enough credits" over a balance the webhook had raised.
  const refreshBalanceForAMinute = () => {
    stopBalanceRefreshRef.current?.();
    stopBalanceRefreshRef.current = pollCreditBalanceAfterPayment();
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
      // Before the order, so a script that cannot load leaves no order behind.
      await loadRazorpayCheckout(CREDIT_CHECKOUT_SCRIPT_ID);

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
              // Read right before each verify attempt, not at the click: the buyer can
              // spend minutes in the sheet, long enough for that token to expire.
              token: readCheckoutAccessToken,
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
        throw new Error('Razorpay checkout could not load. Check your connection and try again.');
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
