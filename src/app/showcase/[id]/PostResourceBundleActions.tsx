'use client';

import Script from 'next/script';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, ExternalLink, Loader2, ShoppingCart, Sparkles } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { getCurrentInternalPath } from '@/lib/share';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  }
}

interface PostResourceBundleActionsProps {
  postId: string;
  title: string;
  priceLabel: string;
  priceUsdCents: number;
  priceNote: string | null;
  isFree: boolean;
  viewerCanAccess: boolean;
  viewerIsOwner: boolean;
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
}

export default function PostResourceBundleActions({
  postId,
  title,
  priceLabel,
  priceUsdCents,
  priceNote,
  isFree,
  viewerCanAccess,
  viewerIsOwner,
  promptText,
  notesMarkdown,
  workflowShareUrl,
}: PostResourceBundleActionsProps) {
  const router = useRouter();
  const { session, credits, updateCredits } = useAuth();
  const [workingAction, setWorkingAction] = useState<'free' | 'razorpay' | 'credits' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accessLabel = useMemo(() => {
    if (viewerIsOwner) {
      return 'You own this unlock.';
    }

    if (viewerCanAccess) {
      return 'Unlock opened on this post.';
    }

    return isFree ? 'Open the prompt, remix access, and workflow notes for free.' : `Open the full unlock for ${priceLabel}.`;
  }, [isFree, priceLabel, viewerCanAccess, viewerIsOwner]);
  const creditCost = Math.max(0, priceUsdCents);
  const formattedCreditCost = creditCost.toLocaleString();
  const formattedCreditBalance = typeof credits === 'number' ? credits.toLocaleString() : null;
  const hasKnownInsufficientCredits = Boolean(session?.access_token && typeof credits === 'number' && credits < creditCost);
  const isAnyActionWorking = workingAction !== null;

  const copyText = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(successMessage);
      setError(null);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Failed to copy.');
      setFeedback(null);
    }
  };

  const unlockFree = async () => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}#resources`))}`);
      return;
    }

    try {
      setWorkingAction('free');
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/resource-bundle/unlock-free`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to open the free unlock.');
      }

      router.refresh();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to open the free unlock.');
    } finally {
      setWorkingAction(null);
    }
  };

  const startCheckout = async () => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}#resources`))}`);
      return;
    }

    try {
      setWorkingAction('razorpay');
      setFeedback(null);
      setError(null);

      const orderResponse = await fetch(`/api/posts/${postId}/resource-bundle/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          locale: typeof navigator !== 'undefined' ? navigator.language : null,
        }),
      });
      const orderData = await orderResponse.json();

      if (!orderResponse.ok) {
        throw new Error(orderData.error || 'Failed to start checkout.');
      }

      if (orderData.alreadyPurchased) {
        router.refresh();
        return;
      }

      if (!window.Razorpay) {
        throw new Error('Razorpay checkout is still loading. Please try again.');
      }

      const razorpay = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'magicbooklet unlock',
        description: orderData.bundleTitle || title,
        order_id: orderData.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verifyResponse = await fetch(`/api/posts/${postId}/resource-bundle/verify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify(response),
            });
            const verifyData = await verifyResponse.json();

            if (!verifyResponse.ok || !verifyData.success) {
              throw new Error(verifyData.error || 'Payment verification failed.');
            }

            router.refresh();
          } catch (verifyError) {
            setError(verifyError instanceof Error ? verifyError.message : 'Payment verification failed.');
          }
        },
        theme: {
          color: '#34d399',
        },
      });

      razorpay.on('payment.failed', (payload: unknown) => {
        const errorPayload = payload as { error?: { description?: string } } | null;
        setError(errorPayload?.error?.description || 'Payment failed. Please try again.');
      });

      razorpay.open();
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : 'Failed to start checkout.');
    } finally {
      setWorkingAction(null);
    }
  };

  const unlockWithCredits = async () => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}#resources`))}`);
      return;
    }

    if (hasKnownInsufficientCredits) {
      setError(`This unlock costs ${formattedCreditCost} credits. Add credits to continue.`);
      setFeedback(null);
      return;
    }

    try {
      setWorkingAction('credits');
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/resource-bundle/unlock-with-credits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok || !data?.success) {
        throw new Error(data.error || 'Failed to unlock with credits.');
      }

      if (typeof data.credits === 'number') {
        updateCredits(data.credits);
      }

      setFeedback(data.alreadyProcessed ? 'This unlock was already available on your account.' : 'Unlocked with credits.');
      router.refresh();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock with credits.');
    } finally {
      setWorkingAction(null);
    }
  };

  return (
    <div className="rounded-[28px] border border-white/8 bg-zinc-900/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
      <Script id="post-resource-bundle-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />

      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Unlock</div>
      <div className="mt-3 text-3xl font-semibold text-white">{priceLabel}</div>
      <p className="mt-3 text-sm leading-7 text-zinc-300">{accessLabel}</p>
      {priceNote ? (
        <p className="mt-2 text-xs leading-5 text-zinc-500">{priceNote}</p>
      ) : null}

      <div className="mt-5 flex flex-col gap-3">
        {!viewerCanAccess && !viewerIsOwner && isFree ? (
          <button
            type="button"
            onClick={() => void unlockFree()}
            disabled={isAnyActionWorking}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {workingAction === 'free' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
            Open free unlock
          </button>
        ) : null}

        {!viewerCanAccess && !viewerIsOwner && !isFree ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void startCheckout()}
                disabled={isAnyActionWorking}
                className="inline-flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/30 bg-emerald-300 px-4 py-3 text-center text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <span className="inline-flex items-center gap-2">
                  {workingAction === 'razorpay' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                  Pay with Razorpay
                </span>
                <span className="text-xs font-medium text-slate-800">Razorpay: {priceLabel}</span>
              </button>

              <button
                type="button"
                onClick={() => void unlockWithCredits()}
                disabled={isAnyActionWorking || hasKnownInsufficientCredits}
                className="inline-flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/25 bg-white/[0.04] px-4 py-3 text-center text-sm font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <span className="inline-flex items-center gap-2">
                  {workingAction === 'credits' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Unlock with credits
                </span>
                <span className="text-xs font-medium text-zinc-300">Credit cost: {formattedCreditCost} credits</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
              <span>
                {formattedCreditBalance ? `${formattedCreditBalance} credits available` : 'Sign in to see your credit balance'}
              </span>
              {hasKnownInsufficientCredits ? (
                <a href="/pricing" className="font-semibold text-emerald-200 underline-offset-4 transition hover:text-emerald-100 hover:underline">
                  Buy credits
                </a>
              ) : null}
            </div>
          </>
        ) : null}

        {viewerCanAccess && promptText ? (
          <button
            type="button"
            onClick={() => void copyText(promptText, 'Prompt copied to clipboard.')}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
          >
            <Copy className="h-4 w-4" />
            Copy prompt
          </button>
        ) : null}

        {viewerCanAccess && notesMarkdown ? (
          <button
            type="button"
            onClick={() => void copyText(notesMarkdown, 'Notes copied to clipboard.')}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
          >
            <Copy className="h-4 w-4" />
            Copy notes
          </button>
        ) : null}

        {viewerCanAccess && workflowShareUrl ? (
          <a
            href={workflowShareUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
          >
            <ExternalLink className="h-4 w-4" />
            Open workflow link
          </a>
        ) : null}
      </div>

      {feedback ? (
        <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">
          {feedback}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
    </div>
  );
}
