'use client';

import Script from 'next/script';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Link2,
  LockKeyhole,
  Loader2,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  describePostResourceKinds,
  formatPostResourceBundleCountSummary,
  formatUnlockCountLabel,
  getPostResourceItemTypeLabel,
  getPostResourceKindLabel,
  type PostResourceAttachment,
  type PostResourceBundleLockedPreview,
  type PostResourceItem,
  type PostResourceItemType,
  type PostResourceKind,
  type PostResourceSection,
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
  priceUsdCents: number;
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
    sections?: PostResourceSection[];
    items?: PostResourceItem[];
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
    sections?: PostResourceSection[];
    items?: PostResourceItem[];
  } | null;
}

const RESOURCE_ITEM_GROUP_ORDER: PostResourceItemType[] = [
  'prompt',
  'workflow',
  'reference_image',
  'source_file',
  'preset',
  'settings',
  'note',
  'external_link',
  'remix_access',
];

function groupResourceItems(items: PostResourceItem[]) {
  return RESOURCE_ITEM_GROUP_ORDER
    .map((type) => ({
      type,
      items: items.filter((item) => item.type === type),
    }))
    .filter((group) => group.items.length > 0);
}

function groupResourceItemsBySection(items: PostResourceItem[], sections: PostResourceSection[]) {
  const globalItems = items.filter((item) => !item.sectionId);
  const globalGroup = globalItems.length > 0
    ? [{
        id: 'global',
        title: 'Full post resources',
        description: null as string | null,
        items: globalItems,
      }]
    : [];

  const sectionGroups = sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      items: items.filter((item) => item.sectionId === section.id),
    }))
    .filter((group) => group.items.length > 0);

  return [...globalGroup, ...sectionGroups];
}

function getResourceItemGroupTitle(type: PostResourceItemType, count: number) {
  const label = getPostResourceItemTypeLabel(type, count);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatResourceItemRole(role: string) {
  return role.replace(/_/g, ' ');
}

export default function PostResourceBundlePanel({
  postId,
  title,
  summary,
  previewText,
  priceLabel,
  priceUsdCents,
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
  const { session, credits, updateCredits } = useAuth();
  const [hasAccess, setHasAccess] = useState(viewerCanAccess || viewerIsOwner);
  const [resources, setResources] = useState(initialResources);
  const [workingAction, setWorkingAction] = useState<'free' | 'razorpay' | 'credits' | 'file' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resourceFileUrls, setResourceFileUrls] = useState<Record<string, string>>({});

  const summaryLine = useMemo(
    () => summary || previewText || describePostResourceKinds(resourceKinds),
    [previewText, resourceKinds, summary]
  );
  const preview = useMemo<PostResourceBundleLockedPreview>(() => (
    lockedPreview ?? {
      resourceKinds,
      attachmentPreviews: [],
      itemCounts: {},
      itemPreviews: [],
      sectionCount: 0,
      sectionPreviews: [],
      hasPrompt: resourceKinds.includes('prompt'),
      hasNotes: resourceKinds.includes('notes'),
      hasWorkflow: resourceKinds.includes('workflow'),
      hasRemix: resourceKinds.includes('remix'),
      updatedAt: null,
    }
  ), [lockedPreview, resourceKinds]);
  const isPromptOnlyUnlock =
    preview.resourceKinds.length === 1 &&
    preview.resourceKinds[0] === 'prompt' &&
    preview.hasPrompt &&
    !preview.hasWorkflow &&
    !preview.hasNotes &&
    !preview.hasRemix &&
    preview.attachmentPreviews.length === 0;
  const bundleCountSummary = useMemo(
    () => formatPostResourceBundleCountSummary(preview),
    [preview]
  );
  const groupedResourceItems = useMemo(
    () => groupResourceItems(resources?.items ?? []),
    [resources?.items]
  );
  const groupedSectionResources = useMemo(
    () => groupResourceItemsBySection(resources?.items ?? [], resources?.sections ?? []),
    [resources?.items, resources?.sections]
  );
  const hasSectionedResourceItems = (resources?.sections?.length ?? 0) > 0 && groupedSectionResources.length > 0;
  const hasStructuredResourceItems = groupedResourceItems.length > 0;
  const isRecipeVisible = hasAccess || viewerIsOwner;
  const accessLabel = useMemo(() => {
    if (viewerIsOwner) {
      return 'You own this unlock.';
    }

    if (hasAccess) {
      return isFree
        ? 'Prompt, notes, references, and files are public on this post.'
        : 'Unlock opened on this post.';
    }

    return isFree ? 'Open the full unlock for free.' : `Open the full unlock for ${priceLabel}.`;
  }, [hasAccess, isFree, priceLabel, viewerIsOwner]);
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
      setWorkingAction('free');
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
      setWorkingAction(null);
    }
  };

  const startCheckout = async () => {
    if (!ensureAuthenticated()) {
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
      setWorkingAction(null);
    }
  };

  const unlockWithCredits = async () => {
    if (!ensureAuthenticated()) {
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
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok || !data?.success) {
        throw new Error(data.error || 'Failed to unlock with credits.');
      }

      if (typeof data.credits === 'number') {
        updateCredits(data.credits);
      }

      await fetchLatestBundle();
      setFeedback(data.alreadyProcessed ? 'This unlock was already available on your account.' : 'Unlocked with credits.');
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock with credits.');
    } finally {
      setWorkingAction(null);
    }
  };

  const fetchResourceFileUrl = useCallback(async (storagePath: string): Promise<string> => {
    const response = await fetch(`/api/posts/${postId}/resource-bundle/file-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token
          ? {
              Authorization: `Bearer ${session.access_token}`,
            }
          : {}),
      },
      body: JSON.stringify({ storagePath }),
    });
    const data = await response.json();

    if (!response.ok || !data.signedUrl) {
      throw new Error(data.error || 'Failed to open resource file.');
    }

    return data.signedUrl as string;
  }, [postId, session]);

  const resolveResourceFileUrl = async (storagePath: string): Promise<string | null> => {
    if (!isFree && !ensureAuthenticated()) {
      return null;
    }

    return fetchResourceFileUrl(storagePath);
  };

  const openResourceFile = async (storagePath: string) => {
    try {
      setWorkingAction('file');
      setFeedback(null);
      setError(null);

      const signedUrl = await resolveResourceFileUrl(storagePath);
      if (signedUrl) {
        window.open(signedUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Failed to open resource file.');
    } finally {
      setWorkingAction(null);
    }
  };

  useEffect(() => {
    if (!isRecipeVisible || !resources?.items?.length) {
      return;
    }

    const previewItems = resources.items.filter((item) => {
      if (!item.storagePath || resourceFileUrls[item.storagePath]) {
        return false;
      }

      return Boolean(
        item.contentType?.startsWith('image/') ||
        item.contentType?.startsWith('video/') ||
        item.contentType?.startsWith('audio/')
      );
    });

    if (previewItems.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      previewItems.map(async (item) => {
        try {
          const signedUrl = await fetchResourceFileUrl(item.storagePath ?? '');
          return [item.storagePath, signedUrl] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) {
        return;
      }

      const resolvedEntries = entries.filter((entry): entry is readonly [string, string] => Boolean(entry));
      if (resolvedEntries.length === 0) {
        return;
      }

      setResourceFileUrls((currentUrls) => ({
        ...currentUrls,
        ...Object.fromEntries(resolvedEntries),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [fetchResourceFileUrl, isRecipeVisible, resourceFileUrls, resources?.items]);

  const downloadResourceFile = async (storagePath: string, filename: string) => {
    try {
      setWorkingAction('file');
      setFeedback(null);
      setError(null);

      const signedUrl = await resolveResourceFileUrl(storagePath);
      if (signedUrl) {
        const anchor = document.createElement('a');
        anchor.href = signedUrl;
        anchor.download = filename;
        anchor.rel = 'noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Failed to download resource file.');
    } finally {
      setWorkingAction(null);
    }
  };

  const formattedUpdatedAt = preview.updatedAt
    ? new Date(preview.updatedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const includedResourceLabel = preview.resourceKinds.length > 0
    ? bundleCountSummary || preview.resourceKinds.map((kind) => getPostResourceKindLabel(kind)).join(', ')
    : 'Reusable resources';

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

  const renderResourceItemMediaPreview = (item: PostResourceItem) => {
    const signedUrl = item.storagePath ? resourceFileUrls[item.storagePath] : null;
    if (!signedUrl || !item.contentType) {
      return null;
    }

    if (item.contentType.startsWith('image/')) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={signedUrl}
          alt={item.title}
          className="mb-3 max-h-64 w-full rounded-2xl border border-white/8 bg-black object-contain"
        />
      );
    }

    if (item.contentType.startsWith('video/')) {
      return (
        <video
          src={signedUrl}
          controls
          className="mb-3 max-h-72 w-full rounded-2xl border border-white/8 bg-black"
        />
      );
    }

    if (item.contentType.startsWith('audio/')) {
      return (
        <audio
          src={signedUrl}
          controls
          className="mb-3 w-full"
        />
      );
    }

    return null;
  };

  return (
    <div
      id="resources"
      className="overflow-hidden rounded-[28px] border border-emerald-300/20 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.14),transparent_42%),linear-gradient(180deg,rgba(10,18,15,0.92),rgba(7,8,9,0.94))] shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl"
    >
      <Script id="post-resource-bundle-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />

      <div className="border-b border-emerald-300/10 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
              {isRecipeVisible ? 'Creation recipe' : 'Unlock details'}
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-white">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-300">{summaryLine}</p>
          </div>

          <div className="rounded-full border border-emerald-300/25 bg-emerald-300 px-3.5 py-1.5 text-sm font-bold text-slate-950">
            {isRecipeVisible ? (isFree ? 'Public recipe' : 'Unlocked') : isFree ? 'Free unlock' : priceLabel}
          </div>
        </div>
      </div>

      <div className="m-5 rounded-[22px] border border-white/8 bg-black/35 p-5 sm:m-6">
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
          <span>{formatUnlockCountLabel(isFree ? 'free' : 'paid', salesCount)}</span>
          {priceNote ? <span>{priceNote}</span> : null}
          <span>
            {hasAccess || viewerIsOwner
              ? 'Everything attached is available below.'
              : 'Reusable parts reveal here after unlock.'}
          </span>
        </div>

        {!hasAccess && !viewerIsOwner && isFree ? (
          <button
            type="button"
            onClick={() => void unlockFree()}
            disabled={isAnyActionWorking}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {workingAction === 'free' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
            Open free unlock
          </button>
        ) : null}

        {!hasAccess && !viewerIsOwner && !isFree ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void startCheckout()}
              disabled={isAnyActionWorking}
              className="inline-flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/30 bg-emerald-300 px-4 py-3 text-center text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span className="inline-flex items-center gap-2">
                {workingAction === 'razorpay' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
                Pay {priceLabel} with Razorpay
              </span>
              <span className="text-xs font-medium text-slate-800">Secure checkout</span>
            </button>

            <button
              type="button"
              onClick={() => void unlockWithCredits()}
              disabled={isAnyActionWorking || hasKnownInsufficientCredits}
              className="inline-flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/25 bg-white/[0.04] px-4 py-3 text-center text-sm font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="inline-flex items-center gap-2">
                {workingAction === 'credits' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Use {formattedCreditCost} credits
              </span>
              <span className="text-xs font-medium text-zinc-300">Credit cost: {formattedCreditCost} credits</span>
            </button>
          </div>
        ) : null}

        {!hasAccess && !viewerIsOwner && !isFree ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <span>
              {formattedCreditBalance ? `${formattedCreditBalance} credits available` : 'Sign in to see your credit balance'}
            </span>
            {hasKnownInsufficientCredits ? (
              <a href="/pricing" className="font-semibold text-emerald-200 underline-offset-4 transition hover:text-emerald-100 hover:underline">
                Buy credits
              </a>
            ) : null}
          </div>
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

      {!isRecipeVisible ? (
      <div className="mx-5 rounded-[22px] border border-sky-300/12 bg-sky-500/[0.06] p-5 sm:mx-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-200/80">
          <ShieldCheck className="h-4 w-4" />
          Buyer trust
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/8 bg-black/25 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Included after unlock</div>
            <p className="mt-2 text-sm leading-6 text-zinc-200">{includedResourceLabel}</p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Access</div>
            <p className="mt-2 text-sm leading-6 text-zinc-200">
              {isFree ? 'Instant access after login.' : 'Pay with Razorpay or spend credits for instant access.'}
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Terms</div>
            <p className="mt-2 text-sm leading-6 text-zinc-300">
              Digital unlocks are final sale. Use for personal or commercial creation; do not resell, redistribute, or claim the raw bundle as your own.
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/25 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Proof</div>
            <p className="mt-2 text-sm leading-6 text-zinc-300">
              {formatUnlockCountLabel(isFree ? 'free' : 'paid', salesCount)}
              {formattedUpdatedAt ? ` · Updated ${formattedUpdatedAt}` : ''}
            </p>
          </div>
        </div>
      </div>
      ) : null}

      <div className="m-5 rounded-[22px] border border-white/8 bg-black/35 p-5 sm:m-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {hasAccess || viewerIsOwner ? <FileText className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
          {hasAccess || viewerIsOwner ? 'Recipe contents' : 'Preview before access'}
        </div>
        {isPromptOnlyUnlock ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-300/20 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-50">
                Prompt
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-medium text-zinc-200">
                {viewerIsOwner ? 'Owner access' : hasAccess ? 'Unlocked' : 'Locked'}
              </span>
              {formattedUpdatedAt ? (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm text-zinc-400">
                  Updated {formattedUpdatedAt}
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-sm leading-7 text-zinc-400">
              {hasAccess || viewerIsOwner
                ? 'The prompt is available below.'
                : 'The prompt text stays locked until this unlock is opened.'}
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm leading-7 text-zinc-400">
              {isRecipeVisible
                ? 'Prompt, notes, references, and files are available here as a creation recipe.'
                : 'Labels and file types can be shown publicly. Prompt text, notes, workflow URLs, storage paths, and file links stay gated.'}
            </p>
            {bundleCountSummary ? (
              <div className="mt-4 rounded-2xl border border-emerald-300/15 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-50">
                {`Includes ${bundleCountSummary}`}
              </div>
            ) : null}
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
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                  {isRecipeVisible ? 'Available now' : 'Locked until access'}
                </div>
                <div className="mt-3 space-y-1.5 text-sm text-zinc-300">
                  {preview.hasPrompt ? <div>Prompt text</div> : null}
                  {preview.hasWorkflow ? <div>Workflow link or snapshot</div> : null}
                  {preview.hasNotes ? <div>Notes or guide</div> : null}
                  {preview.hasRemix ? <div>Remix access</div> : null}
                  {bundleCountSummary ? <div>Structured bundle: {bundleCountSummary}</div> : null}
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
          </>
        )}
      </div>

      {hasAccess || viewerIsOwner ? (
        <div className="mt-6 space-y-5">
          {hasStructuredResourceItems ? (
            hasSectionedResourceItems ? (
              <>
                {groupedSectionResources.map((sectionGroup) => (
                  <div key={sectionGroup.id} className="rounded-[24px] border border-white/8 bg-black/30 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                          Resource section
                        </div>
                        <h3 className="mt-2 text-base font-semibold text-white">{sectionGroup.title}</h3>
                        {sectionGroup.description ? (
                          <p className="mt-1 text-sm leading-6 text-zinc-400">{sectionGroup.description}</p>
                        ) : null}
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-zinc-300">
                        {sectionGroup.items.length} item{sectionGroup.items.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div className="mt-4 space-y-4">
                      {groupResourceItems(sectionGroup.items).map((group) => (
                        <div key={`${sectionGroup.id}:${group.type}`} className="rounded-[20px] border border-white/8 bg-white/[0.025] p-4">
                          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                            {getResourceItemGroupTitle(group.type, group.items.length)}
                          </div>
                          <div className="mt-3 space-y-3">
                            {group.items.map((item, index) => {
                              const key = `${sectionGroup.id}:${item.type}:${item.title}:${index}`;
                              const meta = [
                                formatResourceItemRole(item.role),
                                item.contentType,
                                formatFileSize(item.sizeBytes),
                                item.remixUse !== 'none' ? formatResourceItemRole(item.remixUse) : null,
                              ].filter(Boolean).join(' · ');

                              return (
                                <div key={key} className="rounded-2xl border border-white/8 bg-black/25 p-4">
                                  {renderResourceItemMediaPreview(item)}
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <div className="text-sm font-semibold text-white">{item.title}</div>
                                      {item.description ? (
                                        <p className="mt-1 text-sm leading-6 text-zinc-400">{item.description}</p>
                                      ) : null}
                                      {meta ? <p className="mt-1 text-xs capitalize text-zinc-500">{meta}</p> : null}
                                    </div>
                                    {item.textContent ? (
                                      <button
                                        type="button"
                                        onClick={() => void copyText(item.textContent ?? '', `${item.title} copied to clipboard.`)}
                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                      >
                                        <Copy className="h-3.5 w-3.5" />
                                        Copy
                                      </button>
                                    ) : null}
                                  </div>

                                  {item.textContent ? (
                                    <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">{item.textContent}</pre>
                                  ) : null}

                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {item.externalUrl ? (
                                      <a
                                        href={item.externalUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                      >
                                        <ExternalLink className="h-4 w-4" />
                                        Open link
                                      </a>
                                    ) : null}
                                    {item.storagePath ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => void openResourceFile(item.storagePath ?? '')}
                                          className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/15"
                                        >
                                          <ExternalLink className="h-4 w-4" />
                                          Open file
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void downloadResourceFile(item.storagePath ?? '', item.title)}
                                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                        >
                                          <Download className="h-4 w-4" />
                                          Download
                                        </button>
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
              {groupedResourceItems.map((group) => (
                <div key={group.type} className="rounded-[24px] border border-white/8 bg-black/30 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                    {getResourceItemGroupTitle(group.type, group.items.length)}
                  </div>
                  <div className="mt-3 space-y-3">
                    {group.items.map((item, index) => {
                      const key = `${item.type}:${item.title}:${index}`;
                      const meta = [
                        formatResourceItemRole(item.role),
                        item.contentType,
                        formatFileSize(item.sizeBytes),
                        item.remixUse !== 'none' ? formatResourceItemRole(item.remixUse) : null,
                      ].filter(Boolean).join(' · ');

                      return (
                        <div key={key} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                          {renderResourceItemMediaPreview(item)}
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-white">{item.title}</div>
                              {item.description ? (
                                <p className="mt-1 text-sm leading-6 text-zinc-400">{item.description}</p>
                              ) : null}
                              {meta ? <p className="mt-1 text-xs capitalize text-zinc-500">{meta}</p> : null}
                            </div>
                            {item.textContent ? (
                              <button
                                type="button"
                                onClick={() => void copyText(item.textContent ?? '', `${item.title} copied to clipboard.`)}
                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                              >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                              </button>
                            ) : null}
                          </div>

                          {item.textContent ? (
                            <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">{item.textContent}</pre>
                          ) : null}

                          <div className="mt-3 flex flex-wrap gap-2">
                            {item.externalUrl ? (
                              <a
                                href={item.externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                              >
                                <ExternalLink className="h-4 w-4" />
                                Open link
                              </a>
                            ) : null}
                            {item.storagePath ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void openResourceFile(item.storagePath ?? '')}
                                  className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/15"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                  Open file
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void downloadResourceFile(item.storagePath ?? '', item.title)}
                                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                                >
                                  <Download className="h-4 w-4" />
                                  Download
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              </>
            )
          ) : null}

          {!hasStructuredResourceItems && resources?.promptText ? (
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
              {viewerIsOwner ? (
                <p className="mt-3 rounded-2xl border border-emerald-300/15 bg-emerald-500/10 px-4 py-3 text-sm leading-6 text-emerald-50/85">
                  Owner preview. Buyers must unlock before seeing this.
                </p>
              ) : null}
            </div>
          ) : null}

          {!hasStructuredResourceItems && resources?.notesMarkdown ? (
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

          {!hasStructuredResourceItems && resources?.workflowShareUrl ? (
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

          {!hasStructuredResourceItems && resources?.attachments.length ? (
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

          {!hasStructuredResourceItems && resources?.allowRemix ? (
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
          {isPromptOnlyUnlock
            ? 'The prompt appears here after this unlock is opened.'
            : 'The public post stays visible. Prompt text, workflow links, notes, files, and optional remix access reveal here after unlock.'}
        </div>
      )}
    </div>
  );
}
