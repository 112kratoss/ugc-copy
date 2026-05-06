'use client';

import Script from 'next/script';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Copy,
  ExternalLink,
  FileText,
  Link2,
  LockKeyhole,
  Loader2,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  describePostResourceKinds,
  getPostResourceKindLabel,
  type PostResourceAttachment,
  type PostResourceBundleLockedPreview,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { getCurrentInternalPath } from '@/lib/share';

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
  lockedPreview: PostResourceBundleLockedPreview | null;
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
  lockedPreview,
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
  const preview = useMemo<PostResourceBundleLockedPreview>(() => (
    lockedPreview ?? {
      resourceKinds,
      attachmentPreviews: [],
      hasPrompt: resourceKinds.includes('prompt'),
      hasNotes: resourceKinds.includes('notes'),
      hasWorkflow: resourceKinds.includes('workflow'),
      hasRemix: resourceKinds.includes('remix'),
      updatedAt: null,
    }
  ), [lockedPreview, resourceKinds]);
  const accessLabel = useMemo(() => {
    if (viewerIsOwner) {
      return 'You own this unlock.';
    }

    if (hasAccess) {
      return 'Unlock opened on this post.';
    }

    return isFree ? 'Open the full unlock for free.' : `Open the full unlock for ${priceLabel}.`;
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
      throw new Error(data.error || 'Failed to refresh the unlock.');
    }

    const bundle = data.bundle as BundleRefreshPayload;
    setHasAccess(bundle.viewerCanAccess || bundle.viewerIsOwner);
    setResources(bundle.resources);
  };

  const ensureAuthenticated = () => {
    if (session?.access_token) {
      return true;
    }

    router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}#resources`))}`);
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
        throw new Error(data.error || 'Failed to open the free unlock.');
      }

      await fetchLatestBundle();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to open the free unlock.');
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

  const openResourceFile = async (storagePath: string) => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      setIsWorking(true);
      setFeedback(null);
      setError(null);

      const response = await fetch(`/api/posts/${postId}/resource-bundle/file-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ storagePath }),
      });
      const data = await response.json();

      if (!response.ok || !data.signedUrl) {
        throw new Error(data.error || 'Failed to open resource file.');
      }

      window.open(data.signedUrl as string, '_blank', 'noopener,noreferrer');
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Failed to open resource file.');
    } finally {
      setIsWorking(false);
    }
  };

  const formattedUpdatedAt = preview.updatedAt
    ? new Date(preview.updatedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const formatFileSize = (sizeBytes: number | null | undefined) => {
    if (!sizeBytes) {
      return null;
    }

    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }

    if (sizeBytes < 1024 * 1024) {
      return `${Math.round(sizeBytes / 102.4) / 10} KB`;
    }

    return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
  };

  return (
    <div
      id="resources"
      className="rounded-[30px] border border-emerald-500/15 bg-emerald-500/5 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm"
    >
      <Script id="post-resource-bundle-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />

      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">Unlock details</div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="mt-2 text-sm leading-7 text-zinc-300">{summaryLine}</p>
        </div>

        <div className="rounded-full border border-emerald-300/20 bg-black/30 px-3 py-1 text-sm font-semibold text-emerald-50">
          {isFree ? 'Free unlock' : priceLabel}
        </div>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/8 bg-black/30 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Access</div>
            <p className="mt-3 text-sm leading-7 text-zinc-300">{accessLabel}</p>
          </div>

          <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-zinc-200">
            {viewerIsOwner ? 'Owner access' : hasAccess ? 'Unlocked' : 'Locked'}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {resourceKinds.map((kind) => (
            <div
              key={kind}
              className="inline-flex items-center rounded-full border border-emerald-300/20 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-50"
            >
              {getPostResourceKindLabel(kind)}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-zinc-400">
          <span>{salesCount} sold</span>
          {priceNote ? <span>{priceNote}</span> : null}
          <span>
            {hasAccess || viewerIsOwner
              ? 'Everything attached is available below.'
              : 'Reusable parts reveal here after unlock.'}
          </span>
        </div>

        {!hasAccess && !viewerIsOwner ? (
          <button
            type="button"
            onClick={() => void (isFree ? unlockFree() : startCheckout())}
            disabled={isWorking}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
            {isFree ? 'Open free unlock' : `Unlock for ${priceLabel}`}
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

      <div className="mt-5 rounded-[24px] border border-white/8 bg-black/30 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {hasAccess || viewerIsOwner ? <FileText className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
          {hasAccess || viewerIsOwner ? 'Included resources' : 'Preview before access'}
        </div>
        <p className="mt-3 text-sm leading-7 text-zinc-400">
          Labels and file types can be shown publicly. Prompt text, notes, workflow URLs, storage paths, and file links stay gated.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Included</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {preview.resourceKinds.length > 0 ? preview.resourceKinds.map((kind) => (
                <span
                  key={kind}
                  className="rounded-full border border-emerald-300/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-50"
                >
                  {getPostResourceKindLabel(kind)}
                </span>
              )) : (
                <span className="text-sm text-zinc-400">Reusable unlock metadata</span>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Locked until access</div>
            <div className="mt-3 space-y-1.5 text-sm text-zinc-300">
              {preview.hasPrompt ? <div>Prompt text</div> : null}
              {preview.hasWorkflow ? <div>Workflow link or snapshot</div> : null}
              {preview.hasNotes ? <div>Notes or guide</div> : null}
              {preview.hasRemix ? <div>Remix access</div> : null}
              {preview.attachmentPreviews.length > 0 ? <div>{preview.attachmentPreviews.length} file/link attachment{preview.attachmentPreviews.length === 1 ? '' : 's'}</div> : null}
              {formattedUpdatedAt ? <div className="text-zinc-500">Updated {formattedUpdatedAt}</div> : null}
            </div>
          </div>
        </div>

        {preview.attachmentPreviews.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Attachment preview</div>
            <div className="mt-3 space-y-2">
              {preview.attachmentPreviews.map((attachment, index) => {
                const meta = [
                  attachment.kind === 'file' ? 'File' : 'Link',
                  attachment.contentType,
                  formatFileSize(attachment.sizeBytes),
                ].filter(Boolean).join(' · ');

                return (
                  <div
                    key={`${attachment.label}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{attachment.label}</span>
                    {meta ? <span className="shrink-0 text-xs text-zinc-500">{meta}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
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
                  attachment.kind === 'file' && attachment.storagePath ? (
                    <button
                      key={`${attachment.label}:${attachment.storagePath}`}
                      type="button"
                      onClick={() => void openResourceFile(attachment.storagePath ?? '')}
                      className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/15"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {attachment.label}
                    </button>
                  ) : (
                    <a
                      key={`${attachment.label}:${attachment.url}`}
                      href={attachment.url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {attachment.label}
                    </a>
                  )
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
          The public post stays visible. Prompt text, workflow links, notes, files, and optional remix access reveal here after unlock.
        </div>
      )}
    </div>
  );
}
