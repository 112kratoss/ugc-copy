'use client';

import ResourceMediaPreview, { createBatchedUrlResolver } from '@/components/ResourceMediaPreview';
import { requestConfirmation } from '@/components/feedback-state';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Play,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import {
  POST_RESOURCE_FILE_URL_BATCH_LIMIT,
  buildPostResourceBundleLockedPreview,
  describePostResourceKinds,
  formatPostResourceBundleCountSummary,
  formatPostResourceDownloadName,
  formatPostResourcePriceLabel,
  formatUnlockCountLabel,
  getPostResourceKinds,
  getPostResourceItemTypeLabel,
  getPostResourceKindLabel,
  type PostResourceAttachment,
  type PostResourceBundleLockedPreview,
  type PostResourceFileDisposition,
  type PostResourceItem,
  type PostResourceItemScope,
  type PostResourceItemType,
  type PostResourceKind,
  type PostResourceSection,
  type PostResourceSignedFileUrl,
} from '@/lib/post-resource-bundles';
import { isPostResourceWebCashEligible } from '@/lib/post-resource-commerce';
import type { ShowcaseMediaItem } from '@/lib/showcase';
import { getCurrentInternalPath } from '@/lib/share';
import { trackProductEvent } from '@/lib/product-analytics';
import {
  clearRazorpayCheckoutIntentKey,
  getOrCreateRazorpayCheckoutIntentKey,
  verifyRazorpayCheckoutUntilSettled,
} from '@/lib/razorpay-checkout-client';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  }
}

const RAZORPAY_CHECKOUT_SCRIPT_ID = 'post-resource-bundle-razorpay-checkout';

/**
 * checkout.js is fetched when a buyer presses Pay, not on every view of a
 * locked recipe. A press while it is still loading waits on the same script;
 * one that failed is removed, so the next press fetches it again.
 */
function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) {
    return Promise.resolve();
  }

  let script = document.getElementById(RAZORPAY_CHECKOUT_SCRIPT_ID) as HTMLScriptElement | null;
  if (!script) {
    script = document.createElement('script');
    script.id = RAZORPAY_CHECKOUT_SCRIPT_ID;
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.head.appendChild(script);
  }

  const pending = script;
  return new Promise<void>((resolve, reject) => {
    pending.addEventListener('load', () => resolve(), { once: true });
    pending.addEventListener('error', () => {
      pending.remove();
      reject(new Error('Razorpay checkout could not load. Check your connection and try again.'));
    }, { once: true });
  });
}

interface PostResourceBundlePanelProps {
  postId: string;
  /**
   * The post's proof media, used to let a buyer filter a package down to one
   * output. Scoped resources otherwise read as a bare count.
   */
  mediaItems?: ShowcaseMediaItem[];
  /** Buyer-library screens resolve files by purchase UUID, including after detachment. */
  fileUrlEndpoint?: string;
  title: string;
  /** The post page passes true when the bundle title just repeats the post title. */
  suppressTitle?: boolean;
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
  salesCount: number | null;
  initialResources: {
    promptText: string | null;
    notesMarkdown: string | null;
    workflowShareUrl: string | null;
    attachments: PostResourceAttachment[];
    allowRemix: boolean;
    sections?: PostResourceSection[];
    items?: PostResourceItem[];
  } | null;
  /**
   * Set only when the creator edited the bundle after this viewer bought it.
   * Snapshotting the purchase is pointless unless the buyer can actually reach
   * it, so the panel offers an explicit switch between the current version and
   * the one they paid for.
   */
  purchasedRevision?: {
    revisionNumber: number;
    purchasedAt: string;
    title: string;
    summary: string;
    previewText: string;
    accessMode: 'free' | 'paid';
    priceUsdCents: number;
    /** Purchase-time proof outputs preserve scoped navigation after edits/deletion. */
    mediaItems?: ShowcaseMediaItem[];
    resources: {
      promptText: string | null;
      notesMarkdown: string | null;
      workflowShareUrl: string | null;
      attachments: PostResourceAttachment[];
      allowRemix: boolean;
      sections?: PostResourceSection[];
      items?: PostResourceItem[];
    };
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
  'reference_video',
  'reference_audio',
  'source_file',
  'preset',
  'settings',
  'note',
  'external_link',
  'remix_link',
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
  const sectionIds = new Set(sections.map((section) => section.id));
  const globalItems = items.filter((item) => !item.sectionId);
  const globalGroup = globalItems.length > 0
    ? [{
        id: 'global',
        title: 'Full post resources',
        description: null as string | null,
        scope: null as PostResourceItemScope | null,
        items: globalItems,
      }]
    : [];

  // A section carries its own scope, and its items may leave theirs at the
  // default -- so the section's is the one that narrows the whole card.
  const sectionGroups = sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      scope: section.scope ?? null,
      items: items.filter((item) => item.sectionId === section.id),
    }))
    .filter((group) => group.items.length > 0);

  const unassignedItems = items.filter((item) => item.sectionId && !sectionIds.has(item.sectionId));
  const unassignedGroup = unassignedItems.length > 0
    ? [{
        id: '__unassigned_resources__',
        title: 'Other resources',
        description: null as string | null,
        scope: null as PostResourceItemScope | null,
        items: unassignedItems,
      }]
    : [];

  return [...globalGroup, ...sectionGroups, ...unassignedGroup];
}

function getResourceItemGroupTitle(type: PostResourceItemType, count: number) {
  const label = getPostResourceItemTypeLabel(type, count);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
/**
 * The default scope — everything applies to every output — is the norm, so
 * labeling it is noise. Only a deliberate narrowing is worth a line.
 */
function formatResourceScopeLabel(scope: PostResourceItemScope | null | undefined): string | null {
  if (!scope || scope.kind === 'all') {
    return null;
  }

  const selectedOutputCount = new Set(scope.mediaKeys).size;
  if (selectedOutputCount === 0) {
    return null;
  }

  return `Applies to ${selectedOutputCount} selected ${selectedOutputCount === 1 ? 'output' : 'outputs'}`;
}

function scopeMatchesMediaKey(
  scope: PostResourceItemScope | null | undefined,
  selectedMediaKey: string | null
): boolean {
  if (!selectedMediaKey || !scope || scope.kind === 'all') {
    return true;
  }
  // A media scope naming no output narrows nothing, the same way the mobile
  // panel normalizes it -- otherwise it would hide itself under every filter.
  if (scope.mediaKeys.length === 0) {
    return true;
  }
  return scope.mediaKeys.includes(selectedMediaKey);
}

function isMediaScope(scope: PostResourceItemScope | null | undefined): boolean {
  return scope?.kind === 'media' && scope.mediaKeys.length > 0;
}

export default function PostResourceBundlePanel({
  postId,
  mediaItems = [],
  fileUrlEndpoint,
  title,
  suppressTitle = false,
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
  purchasedRevision = null,
}: PostResourceBundlePanelProps) {
  const router = useRouter();
  const { session, credits, updateCredits } = useAuth();
  const [hasAccess, setHasAccess] = useState(viewerCanAccess || viewerIsOwner);
  const [resources, setResources] = useState(initialResources);
  const [showPurchasedRevision, setShowPurchasedRevision] = useState(false);
  const [selectedScopeMediaKey, setSelectedScopeMediaKey] = useState<string | null>(null);
  // The buyer sees the creator's latest by default -- honest improvements reach
  // them for free -- but never loses the version they paid for.
  const showingPurchasedRevision = Boolean(showPurchasedRevision && purchasedRevision);
  const activeResources = showingPurchasedRevision && purchasedRevision
    ? purchasedRevision.resources
    : resources;
  const activeTitle = showingPurchasedRevision && purchasedRevision ? purchasedRevision.title : title;
  const activeSummary = showingPurchasedRevision && purchasedRevision ? purchasedRevision.summary : summary;
  const activePreviewText = showingPurchasedRevision && purchasedRevision ? purchasedRevision.previewText : previewText;
  const activeIsFree = showingPurchasedRevision && purchasedRevision
    ? purchasedRevision.accessMode === 'free'
    : isFree;
  const activePriceUsdCents = showingPurchasedRevision && purchasedRevision
    ? purchasedRevision.priceUsdCents
    : priceUsdCents;
  // The purchased version has no quote in the viewer's currency, so both
  // versions are priced in dollars: a rupee latest beside a dollar purchase
  // read as two different prices.
  const activePriceLabel = formatPostResourcePriceLabel(activePriceUsdCents);
  const activeResourceKinds = useMemo(
    () => showingPurchasedRevision && activeResources
      ? getPostResourceKinds(activeResources)
      : resourceKinds,
    [activeResources, resourceKinds, showingPurchasedRevision]
  );
  const activeMediaItems = showingPurchasedRevision && purchasedRevision?.mediaItems
    ? purchasedRevision.mediaItems
    : mediaItems;
  const [workingAction, setWorkingAction] = useState<'free' | 'razorpay' | 'credits' | 'file' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summaryLine = useMemo(
    () => activeSummary || activePreviewText || describePostResourceKinds(activeResourceKinds),
    [activePreviewText, activeResourceKinds, activeSummary]
  );
  const preview = useMemo<PostResourceBundleLockedPreview>(() => (
    showingPurchasedRevision && activeResources
      ? buildPostResourceBundleLockedPreview(activeResources)
      : lockedPreview ?? {
      resourceKinds: activeResourceKinds,
      attachmentPreviews: [],
      itemCounts: {},
      itemPreviews: [],
      sectionCount: 0,
      sectionPreviews: [],
      hasPrompt: activeResourceKinds.includes('prompt'),
      hasNotes: activeResourceKinds.includes('notes'),
      hasWorkflow: activeResourceKinds.includes('workflow'),
      hasRemix: activeResourceKinds.includes('remix'),
      updatedAt: null,
    }
  ), [activeResourceKinds, activeResources, lockedPreview, showingPurchasedRevision]);
  const isPromptOnlyUnlock =
    preview.resourceKinds.length === 1 &&
    preview.resourceKinds[0] === 'prompt' &&
    preview.hasPrompt &&
    !preview.hasWorkflow &&
    !preview.hasNotes &&
    !preview.hasRemix &&
    (preview.cardPreviews?.length ?? 0) === 0 &&
    preview.attachmentPreviews.length === 0;
  const bundleCountSummary = useMemo(
    () => formatPostResourceBundleCountSummary(preview),
    [preview]
  );
  const groupedResourceItems = useMemo(
    () => groupResourceItems(activeResources?.items ?? []),
    [activeResources?.items]
  );
  const groupedSectionResources = useMemo(
    () => groupResourceItemsBySection(activeResources?.items ?? [], activeResources?.sections ?? []),
    [activeResources?.items, activeResources?.sections]
  );
  const visibleSectionResources = useMemo(
    () => groupedSectionResources
      // The section's own scope gates the whole card first; an item only
      // narrows further, and falls back to its section when it has no scope.
      .filter((group) => scopeMatchesMediaKey(group.scope, selectedScopeMediaKey))
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => scopeMatchesMediaKey(item.scope ?? group.scope, selectedScopeMediaKey)),
      }))
      .filter((group) => group.items.length > 0),
    [groupedSectionResources, selectedScopeMediaKey]
  );
  const visibleResourceItems = useMemo(
    () => groupedResourceItems
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => scopeMatchesMediaKey(item.scope, selectedScopeMediaKey)),
      }))
      .filter((group) => group.items.length > 0),
    [groupedResourceItems, selectedScopeMediaKey]
  );
  const hasSectionedResourceItems = (activeResources?.sections?.length ?? 0) > 0 && groupedSectionResources.length > 0;
  const hasStructuredResourceItems = groupedResourceItems.length > 0;
  const isRecipeVisible = hasAccess || viewerIsOwner;
  const creditCost = Math.max(0, Math.round(priceUsdCents));
  const formattedCreditCost = creditCost.toLocaleString('en-US');
  const offersCashCheckout = !isFree && isPostResourceWebCashEligible(creditCost);
  const accessPriceLabel = formatPostResourcePriceLabel(creditCost, priceLabel);
  const allPublicCardPreviews = (preview.cardPreviews ?? []).filter((card) => card.publicTitle.trim().length > 0);
  const selectableMedia = useMemo(
    () => activeMediaItems.filter((item) => Boolean(item.mediaKey)),
    [activeMediaItems]
  );
  const hasScopedResources = activeResources
    ? (activeResources.items ?? []).some((item) => isMediaScope(item.scope))
      || (activeResources.sections ?? []).some((section) => isMediaScope(section.scope))
    : allPublicCardPreviews.some((card) => isMediaScope(card.scope));
  const showMediaScopeFilter = hasScopedResources && selectableMedia.length > 1;
  const publicCardPreviews = selectedScopeMediaKey
    ? allPublicCardPreviews.filter((card) => scopeMatchesMediaKey(card.scope, selectedScopeMediaKey))
    : allPublicCardPreviews;
  const mediaScopeFilter = showMediaScopeFilter ? (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Resources for</div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSelectedScopeMediaKey(null)}
          aria-pressed={selectedScopeMediaKey === null}
          className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${
            selectedScopeMediaKey === null
              ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
              : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
          }`}
        >
          All resources
        </button>
        {selectableMedia.map((item, index) => {
          const mediaKey = item.mediaKey!;
          const selected = selectedScopeMediaKey === mediaKey;
          return (
            <button
              key={mediaKey}
              type="button"
              onClick={() => setSelectedScopeMediaKey(selected ? null : mediaKey)}
              aria-pressed={selected}
              aria-label={`Show resources for output ${index + 1}`}
              className={`flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-xs font-semibold transition ${
                selected
                  ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
                  : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
              }`}
            >
              <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-black">
                {item.previewUrl && item.mediaKind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Play className="h-3 w-3 text-zinc-400" />
                )}
              </span>
              {index + 1}
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  // Drawn only while the recipe is locked to this viewer.
  const accessLabel = isFree
    ? 'Get the full recipe free with one click.'
    : `Unlock the full recipe for ${accessPriceLabel}.`;
  const formattedCreditBalance = typeof credits === 'number' ? credits.toLocaleString() : null;
  const hasKnownInsufficientCredits = Boolean(session?.access_token && typeof credits === 'number' && credits < creditCost);
  const isAnyActionWorking = workingAction !== null;

  useEffect(() => {
    // Scope keys may differ between the live and purchased versions. Returning
    // to the unfiltered view prevents a valid resource set from looking empty
    // merely because the previous version's selected key no longer exists.
    setSelectedScopeMediaKey(null);
  }, [showPurchasedRevision]);

  const disarmPaymentRecheck = useRef<(() => void) | null>(null);
  useEffect(() => {
    const recheck = disarmPaymentRecheck;
    return () => recheck.current?.();
  }, []);

  // The verify poll gives up while a payment can still be capturing, and
  // nothing looked again before a reload. The buyer coming back to the tab
  // (from their bank app, say) is the moment to look once more.
  const recheckPendingPaymentOnFocus = (check: () => Promise<void>) => {
    disarmPaymentRecheck.current?.();
    const disarm = () => {
      window.removeEventListener('focus', onFocus);
      disarmPaymentRecheck.current = null;
    };
    const onFocus = () => {
      disarm();
      void check().catch((recheckError: unknown) => {
        setError(recheckError instanceof Error ? recheckError.message : 'Payment verification failed.');
      });
    };
    window.addEventListener('focus', onFocus);
    disarmPaymentRecheck.current = disarm;
  };

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
      throw new Error(data.error || 'Failed to refresh recipe access.');
    }

    const bundle = data.bundle as BundleRefreshPayload;
    setHasAccess(bundle.viewerCanAccess || bundle.viewerIsOwner);
    setResources(bundle.resources);

    // The page's remix button is rendered from server-computed props
    // (canRemix), which just changed with this unlock. Re-fetch the RSC
    // payload so it appears without a hard reload; client state set above
    // survives a soft refresh.
    router.refresh();
  };

  const ensureAuthenticated = () => {
    if (session?.access_token) {
      return true;
    }

    router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}#recipe`))}`);
    return false;
  };

  const unlockFree = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      trackProductEvent('recipe_unlock_started', { method: 'free', post_id: postId });
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
        throw new Error(data.error || 'Failed to get the free recipe.');
      }

      await fetchLatestBundle();
      trackProductEvent('recipe_unlock_succeeded', { method: 'free', post_id: postId });
    } catch (unlockError) {
      trackProductEvent('recipe_unlock_failed', { method: 'free', post_id: postId });
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to get the free recipe.');
    } finally {
      setWorkingAction(null);
    }
  };

  const startCheckout = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      trackProductEvent('recipe_checkout_started', { method: 'razorpay', post_id: postId });
      setWorkingAction('razorpay');
      setFeedback(null);
      setError(null);

      // Fetched while the order is created; a failed load surfaces where it
      // is awaited, below, and not as an unhandled rejection before that.
      const checkoutScript = loadRazorpayCheckout();
      checkoutScript.catch(() => undefined);

      const checkoutIntentScope = `post-resource:${postId}`;
      const clientIntentKey = getOrCreateRazorpayCheckoutIntentKey(checkoutIntentScope);
      const orderResponse = await fetch(`/api/posts/${postId}/resource-bundle/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          locale: typeof navigator !== 'undefined' ? navigator.language : null,
          clientIntentKey,
        }),
      });
      const orderData = await orderResponse.json();

      if (!orderResponse.ok) {
        if (
          orderData.code === 'CHECKOUT_PAYLOAD_MISMATCH'
          || orderData.code === 'RESOURCE_QUOTE_CHANGED'
        ) {
          clearRazorpayCheckoutIntentKey(checkoutIntentScope);
        }
        throw new Error(orderData.error || 'Failed to start checkout.');
      }

      if (orderData.alreadyPurchased) {
        clearRazorpayCheckoutIntentKey(checkoutIntentScope);
        await fetchLatestBundle();
        return;
      }

      await checkoutScript;
      if (!window.Razorpay) {
        throw new Error('Razorpay checkout could not load. Check your connection and try again.');
      }

      const razorpay = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Magicbooklet recipe',
        description: orderData.bundleTitle || title,
        order_id: orderData.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          const verify = (maxAttempts?: number) => verifyRazorpayCheckoutUntilSettled({
            url: `/api/posts/${postId}/resource-bundle/verify`,
            token: session?.access_token ?? '',
            body: response,
            ...(maxAttempts ? { maxAttempts } : {}),
          });
          const completeCheckout = async () => {
            clearRazorpayCheckoutIntentKey(checkoutIntentScope);
            await fetchLatestBundle();
            trackProductEvent('recipe_checkout_succeeded', { method: 'razorpay', post_id: postId });
          };

          try {
            const verification = await verify();
            if (verification.state === 'pending') {
              setFeedback('Payment received and waiting for capture. This recipe will unlock automatically once confirmed.');
              recheckPendingPaymentOnFocus(async () => {
                if ((await verify(1)).state === 'pending') {
                  return;
                }
                setFeedback(null);
                await completeCheckout();
              });
              return;
            }

            await completeCheckout();
          } catch (verifyError) {
            trackProductEvent('recipe_checkout_failed', { method: 'razorpay', post_id: postId });
            setError(verifyError instanceof Error ? verifyError.message : 'Payment verification failed.');
          }
        },
        theme: {
          color: '#34d399',
        },
      });

      razorpay.on('payment.failed', (payload: unknown) => {
        trackProductEvent('recipe_checkout_failed', { method: 'razorpay', post_id: postId });
        const errorPayload = payload as { error?: { description?: string } } | null;
        setError(errorPayload?.error?.description || 'Payment failed. Please try again.');
      });

      razorpay.open();
    } catch (checkoutError) {
      trackProductEvent('recipe_checkout_failed', { method: 'razorpay', post_id: postId });
      setError(checkoutError instanceof Error ? checkoutError.message : 'Failed to start checkout.');
    } finally {
      setWorkingAction(null);
    }
  };

  const unlockWithCredits = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    // The spend cannot be undone, so it is confirmed first. (A known shortfall
    // never gets here: the button is disabled and "Buy credits" shows instead.)
    const confirmed = await requestConfirmation({
      title: 'Unlock this recipe?',
      message: `${formattedCreditCost} credits will come off your balance right away.`,
      confirmLabel: `Use ${formattedCreditCost} credits`,
    });
    if (!confirmed) {
      return;
    }

    try {
      trackProductEvent('recipe_unlock_started', { method: 'credits', post_id: postId });
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
      setFeedback(data.alreadyProcessed ? 'This recipe was already available on your account.' : 'Recipe unlocked with credits.');
      trackProductEvent('recipe_unlock_succeeded', { method: 'credits', post_id: postId });
    } catch (unlockError) {
      trackProductEvent('recipe_unlock_failed', { method: 'credits', post_id: postId });
      setError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock with credits.');
    } finally {
      setWorkingAction(null);
    }
  };

  const fetchResourceFileUrl = useCallback(async (
    storagePath: string,
    signal?: AbortSignal,
    disposition: PostResourceFileDisposition = 'attachment',
  ): Promise<string> => {
    const response = await fetch(fileUrlEndpoint ?? `/api/posts/${postId}/resource-bundle/file-url`, {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token
          ? {
              Authorization: `Bearer ${session.access_token}`,
            }
          : {}),
      },
      body: JSON.stringify({ storagePath, disposition }),
    });
    const data = await response.json();

    if (!response.ok || !data.signedUrl) {
      throw new Error(data.error || 'Failed to open resource file.');
    }

    return data.signedUrl as string;
  }, [fileUrlEndpoint, postId, session]);

  const fetchResourceFileUrls = useCallback(async (
    storagePaths: string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> => {
    const response = await fetch(fileUrlEndpoint ?? `/api/posts/${postId}/resource-bundle/file-url`, {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ storagePaths, disposition: 'inline' }),
    });
    const data = await response.json();

    if (!response.ok || !Array.isArray(data.files)) {
      throw new Error(data.error || 'Failed to open resource file.');
    }

    return new Map((data.files as PostResourceSignedFileUrl[]).map((file) => [file.storagePath, file.url]));
  }, [fileUrlEndpoint, postId, session]);

  // Every preview the panel draws is signed in one request (one entitlement
  // load on the server, one count against the signing limit) where each used
  // to sign itself. The buyer-library route takes the same batch form.
  const signPreviewUrl = useMemo(
    () => createBatchedUrlResolver(fetchResourceFileUrls, POST_RESOURCE_FILE_URL_BATCH_LIMIT),
    [fetchResourceFileUrls]
  );

  const resolveResourceFileUrl = async (
    storagePath: string,
    disposition: PostResourceFileDisposition,
  ): Promise<string | null> => {
    if (!isFree && !ensureAuthenticated()) {
      return null;
    }

    return fetchResourceFileUrl(storagePath, undefined, disposition);
  };

  const openResourceFile = async (storagePath: string) => {
    try {
      setWorkingAction('file');
      setFeedback(null);
      setError(null);

      // Signed as an attachment, the file Open was pressed to view was saved instead.
      const signedUrl = await resolveResourceFileUrl(storagePath, 'inline');
      if (signedUrl) {
        window.open(signedUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Failed to open resource file.');
    } finally {
      setWorkingAction(null);
    }
  };

  const downloadResourceFile = async (storagePath: string, filename: string) => {
    try {
      setWorkingAction('file');
      setFeedback(null);
      setError(null);

      const signedUrl = await resolveResourceFileUrl(storagePath, 'attachment');
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
    if (!item.contentType) return null;
    if (item.storagePath && item.contentType.startsWith('image/')) {
      return <ResourceMediaPreview key={`${postId}:${item.storagePath}`} mediaType="image" label={item.title}
        resolveUrl={signal => signPreviewUrl(item.storagePath!, signal)} className="mb-3 max-w-full" />;
    }

    if (item.storagePath && (item.contentType.startsWith('video/') || item.contentType.startsWith('audio/'))) {
      return <ResourceMediaPreview
        key={`${postId}:${item.storagePath}`}
        mediaType={item.contentType.startsWith('audio/') ? 'audio' : 'video'}
        label={item.title}
        resolveUrl={signal => signPreviewUrl(item.storagePath!, signal)}
        className="mb-3 max-w-full"
      />;
    }

    return null;
  };

  // One renderer for every unlocked item, sectioned or not: media preview,
  // title, description, file facts, a scope line only when narrowed, then the
  // actions. No role or remix-use enums — those are composer vocabulary.
  // `suppressTitle` avoids the stutter of a lone item titled after its group
  // ("PROMPT" over "Prompt") — the eyebrow already said it.
  const renderResourceItem = (item: PostResourceItem, key: string, suppressTitle = false) => {
    const scopeLabel = formatResourceScopeLabel(item.scope);
    const fileMeta = item.storagePath
      ? [item.contentType, formatFileSize(item.sizeBytes)].filter(Boolean).join(' · ')
      : null;

    return (
      <div key={key} className="border-t border-white/8 pt-4">
        {renderResourceItemMediaPreview(item)}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {suppressTitle ? null : (
              <div className="text-sm font-semibold text-white">{item.title}</div>
            )}
            {item.description ? (
              <p className="mt-1 text-sm leading-6 text-zinc-400">{item.description}</p>
            ) : null}
            {fileMeta ? <p className="mt-1 text-xs text-zinc-500">{fileMeta}</p> : null}
            {scopeLabel ? <p className="mt-1 text-xs text-emerald-100/70">{scopeLabel}</p> : null}
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

        {item.externalUrl || item.storagePath ? (
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
                  onClick={() => void downloadResourceFile(item.storagePath ?? '', formatPostResourceDownloadName(item.title, item.contentType))}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const soloItemEchoesGroup = (group: { type: PostResourceItemType; items: PostResourceItem[] }) =>
    group.items.length === 1
    && group.items[0].title.trim().toLowerCase()
      === getPostResourceItemTypeLabel(group.type, 1).trim().toLowerCase();

  return (
    <section id="recipe" className="min-w-0 scroll-mt-24">
      <span id="resources" aria-hidden className="sr-only" />

      {/*
        * One quiet header line carries everything the old three boxes said:
        * what this is, its state, its track record, its freshness.
        */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
        <span className="font-semibold uppercase tracking-[0.2em] text-emerald-300/80">Recipe</span>
        <span className="rounded-full border border-emerald-300/25 bg-emerald-300 px-2.5 py-0.5 font-bold text-slate-950">
          {isRecipeVisible ? (viewerIsOwner ? 'Owner access' : activeIsFree ? 'Free recipe' : 'Unlocked') : isFree ? 'Free recipe' : accessPriceLabel}
        </span>
        {typeof salesCount === 'number' ? (
          <span>{formatUnlockCountLabel(activeIsFree ? 'free' : 'paid', salesCount)}</span>
        ) : null}
        {formattedUpdatedAt ? <span>Updated {formattedUpdatedAt}</span> : null}
      </div>

      {!suppressTitle ? (
        <h2 className="mt-3 text-lg font-semibold tracking-tight text-white">{activeTitle}</h2>
      ) : null}

      {!isRecipeVisible ? (
        <div className="mt-4 space-y-4">
          <p className="max-w-2xl text-sm leading-7 text-zinc-300">{summaryLine}</p>
          <p className="text-sm leading-7 text-zinc-300">{accessLabel}</p>

          {mediaScopeFilter}

          <div className="flex flex-wrap items-center gap-2">
            {activeResourceKinds.map((kind) => (
              <span
                key={kind}
                className="inline-flex items-center rounded-full border border-emerald-300/20 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-50"
              >
                {getPostResourceKindLabel(kind)}
              </span>
            ))}
            {bundleCountSummary ? (
              <span className="text-xs text-zinc-400">{`Includes ${bundleCountSummary}`}</span>
            ) : null}
            {priceNote && offersCashCheckout ? (
              <span className="text-xs text-zinc-400">{priceNote}</span>
            ) : null}
          </div>

          {allPublicCardPreviews.length > 0 && publicCardPreviews.length === 0 ? (
            <p className="text-sm text-zinc-400">No resources apply to this output.</p>
          ) : null}

          {publicCardPreviews.length > 0 ? (
            <div className="space-y-2">
              {publicCardPreviews.map((card) => {
                const itemCount = Math.max(0, Math.round(card.itemCount));
                const typeLabel = getPostResourceItemTypeLabel(card.resourceType, itemCount || 1);
                const scopeLabel = formatResourceScopeLabel(card.scope);

                return (
                  <div key={card.sectionId} className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm font-semibold text-white">{card.publicTitle}</span>
                      <span className="text-xs text-zinc-500">{typeLabel}</span>
                      <span className="text-xs text-zinc-500">{`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}</span>
                      {scopeLabel ? <span className="text-xs text-zinc-500">{scopeLabel}</span> : null}
                      {card.hasRemix ? <span className="text-xs font-medium text-emerald-200">Remix included</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {preview.attachmentPreviews.length > 0 ? (
            <div className="space-y-2">
              {preview.attachmentPreviews.map((attachment, index) => {
                const meta = [
                  attachment.kind === 'file' ? 'File' : 'Link',
                  attachment.contentType,
                  formatFileSize(attachment.sizeBytes),
                ].filter(Boolean).join(' · ');

                return (
                  <div
                    key={`${attachment.label}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-2.5"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{attachment.label}</span>
                    {meta ? <span className="shrink-0 text-xs text-zinc-500">{meta}</span> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          <p className="text-xs leading-6 text-zinc-500">
            {isPromptOnlyUnlock
              ? 'The prompt text stays locked until this recipe is unlocked.'
              : 'Prompt text, notes, workflow links, files, and remix access reveal after unlock.'}
          </p>
        </div>
      ) : null}

      {/* Unlock actions and their outcomes; each block gates itself. */}
      <div className="mt-1">
        {!hasAccess && !viewerIsOwner && isFree ? (
          <button
            type="button"
            onClick={() => void unlockFree()}
            disabled={isAnyActionWorking}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {workingAction === 'free' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {workingAction === 'free' ? 'Getting resources…' : 'Get resources — Free'}
          </button>
        ) : null}

        {!hasAccess && !viewerIsOwner && !isFree ? (
          <div className={`mt-5 grid gap-3 ${offersCashCheckout ? 'sm:grid-cols-2' : ''}`}>
            {offersCashCheckout ? (
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
            ) : null}

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
              <span className="text-xs font-medium text-zinc-300">
                {offersCashCheckout ? `Credit cost: ${formattedCreditCost} credits` : 'Credit-only purchase'}
              </span>
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

      {isRecipeVisible ? (
        <div className="mt-5 space-y-5">
          {purchasedRevision ? (
            <div className="rounded-[20px] border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3">
              <p className="text-xs leading-5 text-amber-100/90">
                The creator has updated this unlock since you bought it. You can read either version.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setShowPurchasedRevision(false)}
                  aria-pressed={!showPurchasedRevision}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                    showPurchasedRevision
                      ? 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
                      : 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200'
                  }`}
                >
                  Latest version
                </button>
                <button
                  type="button"
                  onClick={() => setShowPurchasedRevision(true)}
                  aria-pressed={showPurchasedRevision}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                    showPurchasedRevision
                      ? 'border-amber-300/40 bg-amber-300/10 text-amber-100'
                      : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  The version you unlocked
                </button>
              </div>
              <div className="mt-3 border-t border-amber-200/10 pt-3 text-xs leading-5 text-amber-50/75">
                <p>{summaryLine}</p>
                <p className="mt-1 font-medium text-amber-100">
                  {showingPurchasedRevision ? 'Purchased version' : 'Latest version'}
                  {' · '}
                  {activeIsFree ? 'Free' : activePriceLabel}
                </p>
              </div>
            </div>
          ) : null}

          {mediaScopeFilter}

          {hasStructuredResourceItems && (
            hasSectionedResourceItems
              ? visibleSectionResources.length === 0
              : visibleResourceItems.length === 0
          ) ? (
            <p className="text-sm text-zinc-400">No resources apply to this output.</p>
          ) : null}

          {hasStructuredResourceItems ? (
            hasSectionedResourceItems ? (
              <>
                {visibleSectionResources.map((sectionGroup) => (
                  <div key={sectionGroup.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-base font-semibold text-white">{sectionGroup.title}</h3>
                      <span className="text-xs text-zinc-500">
                        {sectionGroup.items.length} item{sectionGroup.items.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {sectionGroup.description ? (
                      <p className="mt-1 text-sm leading-6 text-zinc-400">{sectionGroup.description}</p>
                    ) : null}
                    <div className="mt-3 space-y-4">
                      {groupResourceItems(sectionGroup.items).map((group) => (
                        <div key={`${sectionGroup.id}:${group.type}`}>
                          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                            {getResourceItemGroupTitle(group.type, group.items.length)}
                          </div>
                          <div className="mt-2 space-y-4">
                            {group.items.map((item, index) =>
                              renderResourceItem(item, `${sectionGroup.id}:${item.type}:${item.title}:${index}`, soloItemEchoesGroup(group)))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
                {visibleResourceItems.map((group) => (
                  <div key={group.type}>
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                      {getResourceItemGroupTitle(group.type, group.items.length)}
                    </div>
                    <div className="mt-2 space-y-4">
                      {group.items.map((item, index) =>
                        renderResourceItem(item, `${item.type}:${item.title}:${index}`, soloItemEchoesGroup(group)))}
                    </div>
                  </div>
                ))}
              </>
            )
          ) : null}

          {!hasStructuredResourceItems && activeResources?.promptText ? (
            <div className="border-t border-white/8 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Prompt</div>
                <button
                  type="button"
                  onClick={() => void copyText(activeResources.promptText ?? '', 'Prompt copied to clipboard.')}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                {activeResources.promptText}
              </pre>
            </div>
          ) : null}

          {!hasStructuredResourceItems && activeResources?.notesMarkdown ? (
            <div className="border-t border-white/8 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Notes</div>
                <button
                  type="button"
                  onClick={() => void copyText(activeResources.notesMarkdown ?? '', 'Notes copied to clipboard.')}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <article className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                {activeResources.notesMarkdown}
              </article>
            </div>
          ) : null}

          {!hasStructuredResourceItems && activeResources?.workflowShareUrl ? (
            <div className="border-t border-white/8 pt-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Workflow</div>
              <a
                href={activeResources.workflowShareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
              >
                <ExternalLink className="h-4 w-4" />
                Open workflow link
              </a>
            </div>
          ) : null}

          {!hasStructuredResourceItems && activeResources?.attachments.length ? (
            <div className="border-t border-white/8 pt-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Files and links</div>
              <div className="mt-3 flex flex-wrap gap-3">
                {activeResources.attachments.map((attachment) => (
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

          {!hasStructuredResourceItems && activeResources?.allowRemix ? (
            <p className="border-t border-white/8 pt-4 text-sm leading-7 text-zinc-300">
              Remix access unlocked — use Remix on this post.
            </p>
          ) : null}

          {viewerIsOwner ? (
            <p className="border-t border-white/8 pt-4 text-sm leading-6 text-emerald-100/80">
              Owner preview. {isFree ? 'People add this recipe before seeing it.' : 'Buyers must unlock the recipe before seeing it.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
