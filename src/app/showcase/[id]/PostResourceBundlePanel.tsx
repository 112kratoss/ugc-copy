'use client';

import Script from 'next/script';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  describePostResourceKinds,
  getPostResourceKindLabel,
  type PostResourceAttachment,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  }
}

interface PostResourceBundlePanelProps {
  postId: string;
  title: string;
  summary: string;
  previewText: string;
  priceLabel: string;
  priceNote: string | null;
  isFree: boolean;
  viewerCanAccess: boolean;
  viewerIsOwner: boolean;
  resourceKinds: PostResourceKind[];
  salesCount: number;
  initialResources: {
    promptText: string | null;
    notesMarkdown: string | null;
    workflowShareUrl: string | null;
    attachments: PostResourceAttachment[];
    allowRemix: boolean;
  } | null;
}

interface BundleRefreshPayload {
  viewerCanAccess: boolean;
  viewerIsOwner: boolean;
  resources: {
    promptText: string | null;
    notesMarkdown: string | null;
    workflowShareUrl: string | null;
    attachments: PostResourceAttachment[];
    allowRemix: boolean;
  } | null;
}

export default function PostResourceBundlePanel({
  postId,
  title,
  summary,
  previewText,
  priceLabel,
  priceNote,
  isFree,
  viewerCanAccess,
  viewerIsOwner,
  resourceKinds,
  salesCount,
  initialResources,
}: PostResourceBundlePanelProps) {
  const router = useRouter();
  const { session } = useAuth();
  const [hasAccess, setHasAccess] = useState(viewerCanAccess || viewerIsOwner);
  const [resources, setResources] = useState(initialResources);
  const [isWorking, setIsWorking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summaryLine = useMemo(
    () => summary || previewText || describePostResourceKinds(resourceKinds),
    [previewText, resourceKinds, summary]
  );
  const accessLabel = useMemo(() => {
    if (viewerIsOwner) {
      return 'You own these resources.';
    }

    if (hasAccess) {
      return 'Resources unlocked on this post.';
    }

    return isFree ? 'Unlock the full resource set for free.' : `Unlock the full resource set for ${priceLabel}.`;
  }, [hasAccess, isFree, priceLabel, viewerIsOwner]);

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

  const fetchLatestBundle = async () => {
    const response = await fetch(`/api/posts/${postId}/resource-bundle`, {
      headers: session?.access_token
        ? {
            Authorization: `Bearer ${session.access_token}`,
          }
        : undefined,
    });
    const data = await response.json();

    if (!response.ok || !data?.bundle) {
      throw new Error(data.error || 'Failed to refresh unlocked resources.');
    }

    const bundle = data.bundle as BundleRefreshPayload;
    setHasAccess(bundle.viewerCanAccess || bundle.viewerIsOwner);
    setResources(bundle.resources);
  };

  const ensureAuthenticated = () => {
    if (session?.access_token) {
      return true;
    }

    router.push(`/login?returnUrl=${encodeURIComponent(`/showcase/${postId}#resources`)}`);
    return false;
  };

  const unlockFree = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      setIsWorking(true);
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/resource-bundle/unlock-free`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to unlock free resources.');
      }

      await fetchLatestBundle();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock free resources.');
    } finally {
      setIsWorking(false);
    }
  };

  const startCheckout = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      setIsWorking(true);
      setFeedback(null);
      setError(null);

      const orderResponse = await fetch(`/api/posts/${postId}/resource-bundle/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
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
        await fetchLatestBundle();
        return;
      }

      if (!window.Razorpay) {
        throw new Error('Razorpay checkout is still loading. Please try again.');
      }

      const razorpay = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'UGC copy resources',
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
                Authorization: `Bearer ${session?.access_token}`,
              },
              body: JSON.stringify(response),
            });
            const verifyData = await verifyResponse.json();

            if (!verifyResponse.ok || !verifyData.success) {
              throw new Error(verifyData.error || 'Payment verification failed.');
            }

            await fetchLatestBundle();
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

  return (
    <div
      id="resources"
      className="rounded-[30px] border border-emerald-500/15 bg-emerald-500/5 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm"
    >
      <Script id="post-resource-bundle-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />

      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">Attached resources</div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="mt-2 text-sm leading-7 text-zinc-300">{summaryLine}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {resourceKinds.map((kind) => (
              <div
                key={kind}
                className="inline-flex items-center rounded-full border border-emerald-300/20 bg-black/30 px-3 py-1 text-sm font-medium text-emerald-50"
              >
                {getPostResourceKindLabel(kind)}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-full border border-emerald-300/20 bg-black/30 px-3 py-1 text-sm font-semibold text-emerald-50">
          {isFree ? 'Free unlock' : priceLabel}
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">What you get</div>
          <p className="mt-3 text-sm leading-7 text-zinc-300">{accessLabel}</p>
          <div className="mt-4 flex flex-wrap gap-3 text-xs text-zinc-400">
            <span>{salesCount} unlock{salesCount === 1 ? '' : 's'}</span>
            {priceNote ? <span>{priceNote}</span> : null}
          </div>

          {!hasAccess && !viewerIsOwner ? (
            <button
              type="button"
              onClick={() => void (isFree ? unlockFree() : startCheckout())}
              disabled={isWorking}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              {isFree ? 'Unlock free resources' : `Unlock for ${priceLabel}`}
            </button>
          ) : null}

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

        <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Unlock state</div>
          <div className="mt-3 text-sm font-semibold text-white">
            {viewerIsOwner ? 'Owner access' : hasAccess ? 'Unlocked' : 'Locked'}
          </div>
          <p className="mt-2 text-sm leading-7 text-zinc-300">
            {hasAccess || viewerIsOwner
              ? 'Everything attached to this post is available below.'
              : 'The proof stays public. The reusable parts reveal here after unlock.'}
          </p>
        </div>
      </div>

      {hasAccess || viewerIsOwner ? (
        <div className="mt-6 space-y-5">
          {resources?.promptText ? (
            <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Prompt</div>
                <button
                  type="button"
                  onClick={() => void copyText(resources.promptText ?? '', 'Prompt copied to clipboard.')}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                {resources.promptText}
              </pre>
            </div>
          ) : null}

          {resources?.notesMarkdown ? (
            <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Notes</div>
                <button
                  type="button"
                  onClick={() => void copyText(resources.notesMarkdown ?? '', 'Notes copied to clipboard.')}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <article className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                {resources.notesMarkdown}
              </article>
            </div>
          ) : null}

          {resources?.workflowShareUrl ? (
            <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                <Link2 className="h-4 w-4" />
                Workflow
              </div>
              <a
                href={resources.workflowShareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
              >
                <ExternalLink className="h-4 w-4" />
                Open workflow link
              </a>
            </div>
          ) : null}

          {resources?.attachments.length ? (
            <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Files and links</div>
              <div className="mt-3 flex flex-wrap gap-3">
                {resources.attachments.map((attachment) => (
                  <a
                    key={`${attachment.label}:${attachment.url}`}
                    href={attachment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {attachment.label}
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {resources?.allowRemix ? (
            <div className="rounded-[24px] border border-white/8 bg-black/30 p-5">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                <Sparkles className="h-4 w-4" />
                Remix
              </div>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                Remix access is now available. Use the remix action above on this post.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 rounded-[24px] border border-white/8 bg-black/30 p-5 text-sm leading-7 text-zinc-300">
          The proof stays public. Prompt text, workflow links, notes, files, and optional remix access reveal here after unlock.
        </div>
      )}
    </div>
  );
}
