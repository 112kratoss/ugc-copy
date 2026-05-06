'use client';

import Script from 'next/script';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Download, Loader2, ShoppingCart } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { getMarketplaceAssetTypeLabel } from '@/lib/marketplace';
import type { ShowcaseAssetType } from '@/lib/showcase';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  }
}

interface MarketplaceAssetActionsProps {
  assetId: string;
  type: ShowcaseAssetType;
  title: string;
  priceLabel: string;
  priceNote: string | null;
  isFree: boolean;
  viewerCanAccess: boolean;
  viewerIsSeller: boolean;
  promptPack: string | null;
  guideMarkdown: string | null;
  canImportWorkflow: boolean;
}

export default function MarketplaceAssetActions({
  assetId,
  type,
  title,
  priceLabel,
  priceNote,
  isFree,
  viewerCanAccess,
  viewerIsSeller,
  promptPack,
  guideMarkdown,
  canImportWorkflow,
}: MarketplaceAssetActionsProps) {
  const router = useRouter();
  const { session } = useAuth();
  const [isWorking, setIsWorking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lockedLabel = useMemo(() => {
    if (viewerIsSeller) {
      return 'You own this listing.';
    }

    if (viewerCanAccess) {
      return 'Unlocked in your library.';
    }

    return `Unlock this ${getMarketplaceAssetTypeLabel(type).toLowerCase()} for ${priceLabel}.`;
  }, [priceLabel, type, viewerCanAccess, viewerIsSeller]);

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

  const startCheckout = async () => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(`/marketplace/${assetId}`)}`);
      return;
    }

    try {
      setIsWorking(true);
      setError(null);
      setFeedback(null);

      const orderResponse = await fetch('/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          assetId,
          locale: typeof navigator !== 'undefined' ? navigator.language : null,
        }),
      });

      const orderData = await orderResponse.json();
      if (!orderResponse.ok) {
        throw new Error(orderData.error || 'Failed to start checkout.');
      }

      if (orderData.alreadyPurchased || orderData.free) {
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
        name: 'magicbooklet marketplace',
        description: orderData.listingTitle || title,
        order_id: orderData.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verifyResponse = await fetch('/api/marketplace/verify', {
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
      setIsWorking(false);
    }
  };

  const importWorkflow = async () => {
    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(`/marketplace/${assetId}`)}`);
      return;
    }

    try {
      setIsWorking(true);
      setError(null);
      const response = await fetch(`/api/marketplace/assets/${assetId}/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to import workflow.');
      }

      router.push(data.redirectTo || '/create-workflow');
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import workflow.');
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="rounded-[28px] border border-white/8 bg-zinc-900/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
      <Script id="marketplace-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />

      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Access</div>
      <div className="mt-3 text-3xl font-semibold text-white">{priceLabel}</div>
      <p className="mt-3 text-sm leading-7 text-zinc-300">{lockedLabel}</p>
      {priceNote ? (
        <p className="mt-2 text-xs leading-5 text-zinc-500">{priceNote}</p>
      ) : null}

      <div className="mt-5 flex flex-col gap-3">
        {!viewerCanAccess && !viewerIsSeller ? (
          <button
            type="button"
            onClick={() => void startCheckout()}
            disabled={isWorking}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
            {isFree ? 'Get free access' : 'Unlock now'}
          </button>
        ) : null}

        {viewerCanAccess && promptPack ? (
          <button
            type="button"
            onClick={() => void copyText(promptPack, 'Prompt pack copied to clipboard.')}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
          >
            <Copy className="h-4 w-4" />
            Copy prompt pack
          </button>
        ) : null}

        {viewerCanAccess && guideMarkdown ? (
          <button
            type="button"
            onClick={() => void copyText(guideMarkdown, 'Guide copied to clipboard.')}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
          >
            <Copy className="h-4 w-4" />
            Copy guide text
          </button>
        ) : null}

        {viewerCanAccess && canImportWorkflow ? (
          <button
            type="button"
            onClick={() => void importWorkflow()}
            disabled={isWorking}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Import workflow into canvas
          </button>
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
