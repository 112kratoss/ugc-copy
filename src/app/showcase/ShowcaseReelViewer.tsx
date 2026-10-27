'use client';

import PostComments from '@/components/PostComments';
import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import { buildRecipePanelProps } from '@/app/showcase/[id]/recipe-panel-props';
import { buildRecipeTopUpHref } from '@/app/showcase/recipe-reading';

import Link from 'next/link';
import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent, type WheelEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ExternalLink,
  Heart,
  LockKeyhole,
  Loader2,
  MessageCircle,
  MessageSquareText,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';

import CreatorIdentity from '@/components/CreatorIdentity';
import PublicShareButton from '@/components/PublicShareButton';
import TextPostPreviewCard from '@/components/TextPostPreviewCard';
import { useAuth } from '@/components/AuthProvider';
import { readFeedbackSnapshot, requestConfirmation, setToastHost } from '@/components/feedback-state';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import {
  ShowcaseFeedbackMenu,
  getShowcaseRecommendation,
  sendShowcaseFeedEvent,
  sendShowcaseResourceOpenEvent,
  type ShowcaseFeedbackAction,
} from '@/app/showcase/ShowcaseFeedInteraction';
import {
  createShowcaseMediaProgressTracker,
  type ShowcaseMediaProgressTracker,
} from '@/lib/showcase-media-progress';
import {
  formatPostResourceBundleCountSummary,
  formatPostResourcePriceLabel,
  formatUsdCents,
  getPostResourceKindLabel,
  isPostResourceKind,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import { getAssetAccessLabel } from '@/lib/showcase-asset-labels';
import { formatCompactCount } from '@/lib/post-feed-presentation';
import { isPostResourceWebCashEligible } from '@/lib/post-resource-commerce';
import { trackProductEvent } from '@/lib/product-analytics';
import {
  RECIPE_PAYMENT_RECEIVED_MESSAGE,
  clearRazorpayCheckoutIntentKey,
  getOrCreateRazorpayCheckoutIntentKey,
  pollBundleUntilUnlocked,
  readCheckoutAccessToken,
  verifyRazorpayCheckoutUntilSettled,
  type RazorpayCheckoutVerificationResult,
} from '@/lib/razorpay-checkout-client';
import { getCurrentInternalPath } from '@/lib/share';
import { type ShowcaseFeedItem, type ShowcaseMediaItem, getShowcaseItemMediaItems } from '@/lib/showcase';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (payload: unknown) => void) => void;
    };
  }
}

interface ShowcaseReelViewerProps {
  isOpen: boolean;
  items: ShowcaseFeedItem[];
  selectedItemId: string | null;
  savedItemIds: Set<string>;
  accessToken?: string | null;
  hasMoreItems: boolean;
  isLoadingMoreItems: boolean;
  /**
   * The host's last page request failed. The reel stops asking for pages on
   * its own (a failed page left `hasMoreItems` true, and it asked again at
   * once, without end) and shows the message with a Retry.
   */
  loadMoreError?: string | null;
  initialMediaIndex?: number;
  onLoadMoreItems: () => void | Promise<void>;
  onClose: () => void;
  onSelectItemId: (id: string) => void;
  onMediaIndexChange?: (index: number) => void;
  onToggleSave: (id: string) => void | Promise<void>;
  onRemix: (id: string) => void | Promise<void>;
  /** A post's comment count as its thread in the reel reads it, for the host's own copy of the post. */
  onCommentCountChange?: (postId: string, commentCount: number) => void;
  /**
   * What the host knows of a selected post that is not in `items`: a `?post=`
   * link still being read, one the server does not show this viewer (deleted,
   * hidden or blocked), or one whose read failed. The reel opens on that state
   * instead of not opening at all.
   */
  selectedItemStatus?: 'loading' | 'unavailable' | 'failed' | null;
  onRetrySelectedItem?: () => void;
  feedSessionId?: string | null;
  /** The ⋯ menu's two feed rows (Not interested, Hide): given where the reel plays a feed. */
  onFeedback?: (item: ShowcaseFeedItem, action: ShowcaseFeedbackAction) => void | Promise<void>;
  /**
   * The ⋯ menu's safety rows, each shown when given and when it can apply
   * (`ShowcaseFeedbackMenu`): the caller asks, sends and decides what leaves
   * the screen. A reel given none of the four handlers, or showing a post none
   * of their rows applies to (the viewer's own), has no ⋯ at all.
   */
  onReportContent?: (item: ShowcaseFeedItem) => void | Promise<void>;
  onReportUser?: (item: ShowcaseFeedItem) => void | Promise<void>;
  onBlockUser?: (item: ShowcaseFeedItem) => void | Promise<void>;
  /**
   * The page the reel was opened from, as the app shell titles it
   * (`app-shell-nav.ts`): the button that closes the reel goes back there and
   * says so. Explore's by default; a creator's page and the profile name
   * themselves.
   */
  originLabel?: string;
  buildDetailPath: (id: string, section?: string) => string;
}

type ReelTransitionDirection = 'next' | 'previous' | 'neutral';
type ReelUnlockAction = 'free' | 'cash' | 'tokens' | null;
type ReelMediaLoadState = 'ready' | 'error';
const QUALIFIED_REEL_VIEW_DURATION_MS = 1000;
/** The credit unlock spends neither, though both count in the balance. */
const UNSPENDABLE_CREDITS_NOTE = "Welcome and referral credits can't be spent on recipes.";

/**
 * The recipe as `GET /api/posts/{id}/resource-bundle` answers it for this
 * viewer. Typed loosely: whatever the answer leaves out, the post's own
 * listing supplies (`toReelRecipeSource`).
 */
type ReelBundle = Partial<PostResourceBundleDetail> & Pick<PostResourceBundleDetail, 'viewerCanAccess' | 'viewerIsOwner' | 'resources'>;

/**
 * The recipe the post page's panel draws, read from the reel's answer with
 * the listing beneath it, so a partial answer still draws a whole panel.
 */
function toReelRecipeSource(asset: NonNullable<ShowcaseFeedItem['asset']>, bundle: ReelBundle) {
  return {
    title: bundle.title ?? asset.title,
    summary: bundle.summary ?? '',
    previewText: bundle.previewText ?? asset.previewText,
    accessMode: bundle.accessMode ?? asset.accessMode,
    priceUsdCents: bundle.priceUsdCents ?? asset.priceUsdCents,
    priceQuote: bundle.priceQuote ?? {
      formatted: asset.priceQuote?.formatted ?? formatUsdCents(asset.priceUsdCents),
      note: asset.priceQuote?.note ?? null,
    },
    viewerCanAccess: bundle.viewerCanAccess,
    viewerIsOwner: bundle.viewerIsOwner,
    resourceKinds: bundle.resourceKinds ?? (asset.resourceKinds ?? []).filter(isPostResourceKind),
    lockedPreview: bundle.lockedPreview ?? asset.lockedPreview ?? null,
    salesCount: bundle.salesCount ?? asset.salesCount ?? 0,
    freeUnlockCount: bundle.freeUnlockCount ?? asset.freeUnlockCount ?? 0,
    resources: bundle.resources,
    purchasedRevision: bundle.purchasedRevision ?? null,
  };
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) return [];

  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
}

function getItemResourceKinds(item: ShowcaseFeedItem): PostResourceKind[] {
  return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}


function getItemSummary(item: ShowcaseFeedItem): string {
  if (item.body.trim()) {
    return item.body;
  }

  if (item.prompt.trim()) {
    return item.prompt;
  }

  if (item.asset) {
    const kinds = getItemResourceKinds(item);
    const bundleCountSummary = formatPostResourceBundleCountSummary(item.asset.lockedPreview ?? null);
    return bundleCountSummary
      ? `Recipe includes ${bundleCountSummary}.`
      : kinds.length > 0
      ? `Recipe includes ${kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase()).join(', ')}.`
      : 'Reusable recipe attached.';
  }

  return `${item.category === 'text' ? 'Text' : item.category} by ${item.creator.name}`;
}

function getMediaTypeLabel(item: ShowcaseFeedItem): string {
  // "Text", beside Image and Video, as the post page and the app name it.
  if (item.postFormat === 'text' || item.category === 'text') {
    return 'Text';
  }

  const mediaKinds = new Set((item.mediaItems ?? []).map((mediaItem) => mediaItem.mediaKind));
  if (mediaKinds.size > 1) {
    return 'Mixed media';
  }

  if (item.mediaKind === 'video' || mediaKinds.has('video')) {
    return 'Video';
  }

  return 'Image';
}


function getReelMediaLifecycleKey(postId: string, mediaItem: ShowcaseMediaItem): string {
  return JSON.stringify([postId, mediaItem.id, mediaItem.url]);
}

export default function ShowcaseReelViewer({
  isOpen,
  items,
  selectedItemId,
  savedItemIds,
  accessToken,
  hasMoreItems,
  isLoadingMoreItems,
  loadMoreError = null,
  initialMediaIndex = 0,
  onLoadMoreItems,
  onClose,
  onSelectItemId,
  onMediaIndexChange,
  onToggleSave,
  onRemix,
  onCommentCountChange,
  selectedItemStatus = null,
  onRetrySelectedItem,
  feedSessionId,
  onFeedback,
  onReportContent,
  onReportUser,
  onBlockUser,
  originLabel = 'Explore',
  buildDetailPath,
}: ShowcaseReelViewerProps) {
  const router = useRouter();
  const { session, user, credits, marketplaceSpendableCredits, updateCredits } = useAuth();
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const wheelCooldownRef = useRef(0);
  const detailsScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingAdvanceAfterLoadRef = useRef(false);
  const reelDialogRef = useRef<HTMLDivElement | null>(null);
  const reelCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const recipePanelRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useReducedMotion();

  // While the reel is up it draws the app's toasts: inside its `aria-modal`
  // dialog a screen reader still reaches them and its focus trap includes
  // their buttons, and below its header they sit clear of close and ⋯. The
  // dialog exists only while the reel is open, and is another element while
  // its post loads, so the host follows the element, not the viewer's mount.
  const attachReelDialog = useCallback((node: HTMLDivElement | null) => {
    reelDialogRef.current = node;
    setToastHost(node);
  }, []);
  const [transitionDirection, setTransitionDirection] = useState<ReelTransitionDirection>('neutral');
  const [activeMediaIndex, setActiveMediaIndex] = useState(initialMediaIndex);
  const [mediaLoadStates, setMediaLoadStates] = useState<Record<string, ReelMediaLoadState>>({});
  const [activeUnlockCheckoutItemId, setActiveUnlockCheckoutItemId] = useState<string | null>(null);
  const [unlockWorkingAction, setUnlockWorkingAction] = useState<ReelUnlockAction>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockNotice, setUnlockNotice] = useState<string | null>(null);
  // The post whose payment the sheet took and the reel has not yet seen settle.
  // Kept by post, not cleared on a move: that post's buy buttons stay held.
  const [awaitingPaymentItemId, setAwaitingPaymentItemId] = useState<string | null>(null);
  // The post whose credit unlock answered 402 INSUFFICIENT_CREDITS.
  const [creditsRefusedItemId, setCreditsRefusedItemId] = useState<string | null>(null);
  const [remixWorkingItemId, setRemixWorkingItemId] = useState<string | null>(null);
  const [remixError, setRemixError] = useState<string | null>(null);
  const [unlockSuccessItemId, setUnlockSuccessItemId] = useState<string | null>(null);
  // The recipe the reader has, as the post page's panel draws it (B-F1).
  const [unlockedBundle, setUnlockedBundle] = useState<ReelBundle | null>(null);
  // The post the reader unlocked in this reel just now: its panel says so.
  const [justUnlockedItemId, setJustUnlockedItemId] = useState<string | null>(null);
  // A credit unlock answered 409 RESOURCE_PRICE_CHANGED: the price the server
  // holds now for that post, until its listing says otherwise (S3).
  const [priceChanges, setPriceChanges] = useState<Record<string, { fromPriceCredits: number; priceCredits: number }>>({});
  // The thread is open for one post; moving to another closes it.
  const [commentsItemId, setCommentsItemId] = useState<string | null>(null);
  // Counts the open threads have read, ahead of the host's copy of the post.
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  // Whom the signed-in viewer follows, by `viewer:creator`, as the server last said.
  const [followStates, setFollowStates] = useState<Record<string, boolean>>({});
  const [followPendingKey, setFollowPendingKey] = useState<string | null>(null);
  const [followError, setFollowError] = useState<{ key: string; message: string } | null>(null);
  const [copiedPromptItemId, setCopiedPromptItemId] = useState<string | null>(null);
  const followRequestsRef = useRef(new Set<string>());
  const commentsSectionRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = useMemo(
    () => selectedItemId ? items.findIndex((item) => item.id === selectedItemId) : -1,
    [items, selectedItemId]
  );
  const item = selectedIndex >= 0 ? items[selectedIndex] : null;
  const previousItem = selectedIndex > 0 ? items[selectedIndex - 1] : null;
  const nextItem = selectedIndex >= 0 && selectedIndex < items.length - 1 ? items[selectedIndex + 1] : null;
  const selectedFeedItemId = item?.id ?? null;
  const feedEventItemRef = useRef<ShowcaseFeedItem | null>(item);
  // Read when an event is sent, so a token refresh, a new page's session id or
  // an earlier post leaving the list does not end the post on screen and
  // start it again (a dwell or skip filed for it, and a second open).
  const accessTokenRef = useRef(accessToken);
  const feedSessionIdRef = useRef(feedSessionId);
  const selectedIndexRef = useRef(selectedIndex);
  const sessionTokenRef = useRef(session?.access_token ?? null);
  useEffect(() => {
    feedEventItemRef.current = item;
    accessTokenRef.current = accessToken;
    feedSessionIdRef.current = feedSessionId;
    selectedIndexRef.current = selectedIndex;
    sessionTokenRef.current = session?.access_token ?? null;
  }, [accessToken, feedSessionId, item, selectedIndex, session?.access_token]);
  const stopBundlePollRef = useRef<(() => void) | null>(null);
  // A verify can finish after the reel's page has gone; no wait starts then.
  const unmountedRef = useRef(false);
  useEffect(() => {
    const poll = stopBundlePollRef;
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      poll.current?.();
    };
  }, []);
  // One reel session: `open` goes to the post it opened on, and each delivery
  // reports one impression however often the reader comes back to it.
  const openSentRef = useRef(false);
  const impressionDeliveryIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (isOpen) return;
    openSentRef.current = false;
    impressionDeliveryIdsRef.current = new Set();
  }, [isOpen]);
  const mediaProgressTrackerRef = useRef<ShowcaseMediaProgressTracker | null>(null);
  const flushMediaProgressRef = useRef<() => void>(() => {});
  const mediaItems = useMemo(() => item ? getShowcaseItemMediaItems(item) : [], [item]);
  const activeMediaItem = mediaItems[Math.min(activeMediaIndex, Math.max(0, mediaItems.length - 1))] ?? mediaItems[0] ?? null;

  const moveToItem = useCallback((targetItem: ShowcaseFeedItem, direction: ReelTransitionDirection) => {
    setActiveUnlockCheckoutItemId(null);
    setUnlockWorkingAction(null);
    setUnlockError(null);
    setUnlockNotice(null);
    setRemixError(null);
    setCommentsItemId(null);
    setActiveMediaIndex(0);
    setTransitionDirection(direction);
    onSelectItemId(targetItem.id);
  }, [onSelectItemId]);

  useEffect(() => {
    const clampedIndex = Math.min(Math.max(initialMediaIndex, 0), Math.max(0, mediaItems.length - 1));
    // Selecting a different reel item resets its media position from the URL state.
    setActiveMediaIndex(clampedIndex);
  }, [initialMediaIndex, item?.id, mediaItems.length]);

  const requestMoreItems = useCallback((advanceAfterLoad = false) => {
    if (!hasMoreItems || isLoadingMoreItems) {
      return;
    }

    if (advanceAfterLoad) {
      pendingAdvanceAfterLoadRef.current = true;
      setTransitionDirection('next');
    }

    void onLoadMoreItems();
  }, [hasMoreItems, isLoadingMoreItems, onLoadMoreItems]);

  const goPrevious = useCallback(() => {
    if (previousItem) {
      moveToItem(previousItem, 'previous');
    }
  }, [moveToItem, previousItem]);

  const goNext = useCallback(() => {
    if (nextItem) {
      moveToItem(nextItem, 'next');
      return;
    }

    // Opened on a linked post that is not in the list: there is no "after" yet.
    if (hasMoreItems && selectedIndex >= 0) {
      requestMoreItems(true);
    }
  }, [hasMoreItems, moveToItem, nextItem, requestMoreItems, selectedIndex]);

  const handleClose = useCallback(() => {
    setActiveUnlockCheckoutItemId(null);
    setUnlockWorkingAction(null);
    setUnlockError(null);
    setUnlockNotice(null);
    setTransitionDirection('neutral');
    onClose();
  }, [onClose]);

  const fetchBundleForItem = useCallback(async (postId: string, accessToken = session?.access_token) => {
    const response = await fetch(`/api/posts/${postId}/resource-bundle`, {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
    });
    const data = await response.json();

    if (!response.ok || !data?.bundle) {
      throw new Error(data.error || 'Failed to refresh recipe access.');
    }

    return data.bundle as ReelBundle;
  }, [session]);

  const openUnlockCheckout = () => {
    if (!item?.asset) {
      return;
    }

    setActiveUnlockCheckoutItemId(item.id);
    setUnlockError(null);
    setUnlockNotice(null);
    window.requestAnimationFrame(() => {
      detailsScrollerRef.current?.scrollTo({
        top: 0,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    });
  };

  const setMediaLoadState = useCallback((mediaKey: string, nextState: ReelMediaLoadState | null) => {
    setMediaLoadStates((currentStates) => {
      if (nextState === null) {
        if (!(mediaKey in currentStates)) {
          return currentStates;
        }

        const nextStates = { ...currentStates };
        delete nextStates[mediaKey];
        return nextStates;
      }

      if (currentStates[mediaKey] === nextState) {
        return currentStates;
      }

      return {
        ...currentStates,
        [mediaKey]: nextState,
      };
    });
  }, []);

  const mediaVariants = useMemo<Variants>(() => {
    const distance = prefersReducedMotion ? 0 : 34;
    return {
      enter: (direction: ReelTransitionDirection) => ({
        opacity: 0,
        y: direction === 'next' ? distance : direction === 'previous' ? -distance : 0,
        scale: prefersReducedMotion ? 1 : 0.985,
      }),
      center: {
        opacity: 1,
        y: 0,
        scale: 1,
      },
      exit: (direction: ReelTransitionDirection) => ({
        opacity: 0,
        y: direction === 'next' ? -distance : direction === 'previous' ? distance : 0,
        scale: prefersReducedMotion ? 1 : 0.99,
      }),
    };
  }, [prefersReducedMotion]);

  const detailsVariants = useMemo<Variants>(() => {
    const distance = prefersReducedMotion ? 0 : 18;
    return {
      enter: (direction: ReelTransitionDirection) => ({
        opacity: 0,
        y: direction === 'next' ? distance : direction === 'previous' ? -distance : 0,
      }),
      center: {
        opacity: 1,
        y: 0,
      },
      exit: (direction: ReelTransitionDirection) => ({
        opacity: 0,
        y: direction === 'next' ? -distance : direction === 'previous' ? distance : 0,
      }),
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => reelCloseButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  const hasItem = Boolean(item);
  useEffect(() => {
    // A linked post's body replaces the reel's loading state, and the close
    // button focused there goes with it: focus would fall out of the dialog.
    if (!isOpen || !hasItem) return;
    if (!reelDialogRef.current?.contains(document.activeElement)) {
      reelCloseButtonRef.current?.focus();
    }
  }, [hasItem, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    detailsScrollerRef.current?.scrollTo({ top: 0 });
  }, [isOpen, item?.id]);

  useEffect(() => {
    const trackedItem = feedEventItemRef.current;
    if (!isOpen || !trackedItem || trackedItem.id !== selectedFeedItemId) {
      return;
    }

    // One max-progress tracker per viewed item; milestone/background flushes
    // go through the ref so listeners outside this effect stay current.
    const mediaProgressTracker = createShowcaseMediaProgressTracker();
    mediaProgressTrackerRef.current = mediaProgressTracker;
    const eventContext = () => ({
      item: trackedItem,
      sourceSurface: 'showcase-reel' as const,
      accessToken: accessTokenRef.current,
      feedSessionId: feedSessionIdRef.current,
      fallbackPosition: selectedIndexRef.current,
    });
    flushMediaProgressRef.current = () => {
      const flush = mediaProgressTracker.takeFlush();
      if (!flush) return;
      void sendShowcaseFeedEvent({
        ...eventContext(),
        eventType: 'media_progress',
        progress: flush.progress,
        ...(flush.durationMs !== null ? { durationMs: flush.durationMs } : {}),
      }).catch(() => undefined);
    };

    const startedAt = Date.now();
    // `open` is the post the reader chose (the tile, or the link the reel
    // opened on), as the app counts it: swiping on is not opening.
    const sendOpenTimer = window.setTimeout(() => {
      if (openSentRef.current) return;
      openSentRef.current = true;
      void sendShowcaseFeedEvent({ ...eventContext(), eventType: 'open' }).catch(() => undefined);
    }, 0);
    const deliveryId = getShowcaseRecommendation(trackedItem)?.deliveryId ?? null;
    const sendImpressionTimer = window.setTimeout(() => {
      if (!deliveryId || impressionDeliveryIdsRef.current.has(deliveryId)) return;
      impressionDeliveryIdsRef.current.add(deliveryId);
      void sendShowcaseFeedEvent({ ...eventContext(), eventType: 'impression' }).catch(() => undefined);
    }, QUALIFIED_REEL_VIEW_DURATION_MS);

    return () => {
      window.clearTimeout(sendOpenTimer);
      window.clearTimeout(sendImpressionTimer);
      flushMediaProgressRef.current();
      // Under 250 ms the post was flicked past, not seen: neither a skip nor a dwell.
      const durationMs = Date.now() - startedAt;
      if (durationMs < 250) {
        return;
      }

      void sendShowcaseFeedEvent({
        ...eventContext(),
        eventType: durationMs < QUALIFIED_REEL_VIEW_DURATION_MS ? 'quick_skip' : 'dwell',
        durationMs,
      }).catch(() => undefined);
    };
  }, [isOpen, selectedFeedItemId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // App-kill and tab-switch would otherwise lose the furthest playback
    // position; the server upserts with GREATEST so extra flushes are safe.
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        flushMediaProgressRef.current();
      }
    };
    const flushOnPageHide = () => flushMediaProgressRef.current();
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, [isOpen]);

  useEffect(() => {
    // After a failed page only the reader asks again (Retry, or Next at the end).
    if (!isOpen || selectedIndex < 0 || !nextItem || !hasMoreItems || isLoadingMoreItems || loadMoreError) {
      return;
    }

    if (items.length - selectedIndex <= 3) {
      void onLoadMoreItems();
    }
  }, [hasMoreItems, isLoadingMoreItems, isOpen, items.length, loadMoreError, nextItem, onLoadMoreItems, selectedIndex]);

  useEffect(() => {
    if (!pendingAdvanceAfterLoadRef.current || !nextItem) {
      return;
    }

    pendingAdvanceAfterLoadRef.current = false;
    onSelectItemId(nextItem.id);
  }, [nextItem, onSelectItemId]);

  const viewerId = user?.id ?? null;
  const creatorId = item?.creator.id ?? null;
  const followKey = viewerId && creatorId && creatorId !== viewerId ? `${viewerId}:${creatorId}` : null;
  const isFollowStateKnown = followKey !== null && followKey in followStates;
  const hasSessionToken = Boolean(session?.access_token);
  useEffect(() => {
    // Asked once per creator while the reel is open, and never on the viewer's
    // own post. The Follow is drawn once the answer is in, as the app draws it;
    // a failed read leaves it out until the reader lands on that creator again.
    const token = sessionTokenRef.current;
    if (!isOpen || !followKey || !creatorId || isFollowStateKnown || !token) return;
    if (followRequestsRef.current.has(followKey)) return;
    followRequestsRef.current.add(followKey);
    const key = followKey;
    void fetch(`/api/profile/follow?${new URLSearchParams({ followingId: creatorId }).toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load follow state');
        const data = await response.json() as { following?: unknown };
        setFollowStates((current) => key in current ? current : { ...current, [key]: data.following === true });
      })
      .catch(() => undefined)
      .finally(() => {
        followRequestsRef.current.delete(key);
      });
  }, [creatorId, followKey, hasSessionToken, isFollowStateKnown, isOpen]);

  useEffect(() => {
    if (!copiedPromptItemId) return;
    const timer = window.setTimeout(() => setCopiedPromptItemId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedPromptItemId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // A key something above this viewer has already answered is not the
      // viewer's as well. The confirmation asked from its menu ("Report
      // content?") is drawn above it and hears keys first: its Escape has
      // closed the question by the time it arrives here, marked as handled,
      // and must not close the reel too. So are the arrows that step through
      // the open menu's rows. And while the question is open the arrows must
      // not change the post it asks about.
      if (event.defaultPrevented || readFeedbackSnapshot().confirmation) {
        return;
      }

      if (event.key === 'Tab') {
        const activeDialog = reelDialogRef.current;
        const focusable = getFocusableElements(activeDialog);
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!activeDialog?.contains(document.activeElement)) {
          // Focus fell out of the dialog, as it does when a toast it holds
          // goes with its button focused: back in, not on to the page behind.
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      // Writing a comment: the arrows move the caret, not the reel, and
      // Escape must not throw the draft away by closing it.
      if (isTextEntryTarget(event.target)) {
        return;
      }

      if (event.key === 'Escape') {
        handleClose();
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrevious();
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [goNext, goPrevious, handleClose, isOpen]);

  // Re-check access for both free and paid recipes, including purchases made
  // on the detail page before returning to this viewer.
  useEffect(() => {
    if (!isOpen || !item?.id || !item?.asset) {
      return;
    }

    if (unlockSuccessItemId === item.id) {
      return;
    }

    let cancelled = false;

    void fetchBundleForItem(item.id)
      .then((bundle) => {
        if (cancelled) {
          return;
        }

        if (bundle.viewerCanAccess && bundle.resources) {
          setUnlockSuccessItemId(item.id);
          setUnlockedBundle(bundle);
          setUnlockError(null);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }

        setUnlockError(err instanceof Error ? err.message : 'Failed to load recipe access.');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.id, item?.asset?.id, item?.asset?.accessMode, item?.asset?.priceUsdCents, unlockSuccessItemId, fetchBundleForItem]);

  if (!isOpen) {
    return null;
  }

  if (!item) {
    if (!selectedItemStatus) {
      return null;
    }

    return (
      <div
        ref={attachReelDialog}
        role="dialog"
        aria-modal="true"
        aria-label={`${originLabel} reel viewer`}
        className="fixed inset-0 z-[90] overflow-hidden bg-[#050506] text-white"
      >
        <header className="relative z-20 flex h-14 items-center justify-between gap-3 border-b border-white/8 bg-black/40 px-3 backdrop-blur-xl sm:px-5">
          <button
            ref={reelCloseButtonRef}
            type="button"
            onClick={handleClose}
            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
          >
            <X className="h-4 w-4" />
            {originLabel}
          </button>
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">{originLabel} reel</div>
          <div aria-hidden="true" className="w-24" />
        </header>
        <div className="flex h-[calc(100dvh-3.5rem)] items-center justify-center px-6 text-center">
          {selectedItemStatus === 'loading' ? (
            <div role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading post
            </div>
          ) : (
            <div role="alert" className="max-w-sm">
              <h2 className="text-xl font-semibold text-white">
                {selectedItemStatus === 'unavailable' ? 'This post isn’t available' : 'Couldn’t load this post'}
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                {selectedItemStatus === 'unavailable'
                  ? 'It may have been deleted or made private.'
                  : 'Check your connection and try again.'}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {selectedItemStatus === 'failed' && onRetrySelectedItem ? (
                  <button
                    type="button"
                    onClick={onRetrySelectedItem}
                    className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Try again
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleClose}
                  className="ui-focus-ring inline-flex min-h-11 items-center rounded-full border border-white/12 bg-white/[0.05] px-5 text-sm font-bold text-zinc-100 transition hover:bg-white/[0.09]"
                >
                  Back to {originLabel}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const resourceKinds = getItemResourceKinds(item);
  const isSaved = savedItemIds.has(item.id);
  const summary = getItemSummary(item);
  const dateLabel = formatDate(item.createdAt);
  const mediaTypeLabel = getMediaTypeLabel(item);
  const isUnlockCheckoutOpen = Boolean(item.asset && activeUnlockCheckoutItemId === item.id);
  const hasReelUnlockAccess = unlockSuccessItemId === item.id;
  const isFreeUnlock = Boolean(item.asset && (item.asset.accessMode === 'free' || item.asset.priceUsdCents === 0));
  const listedPriceCredits = item.asset ? Math.max(0, Math.round(item.asset.priceUsdCents)) : 0;
  // The price the server answered a credit unlock with (409), while the
  // listing still carries the one the reel was drawn with.
  const priceChange = priceChanges[item.id];
  const tokenCost = priceChange && priceChange.fromPriceCredits === listedPriceCredits
    ? priceChange.priceCredits
    : listedPriceCredits;
  const priceChanged = tokenCost !== listedPriceCredits;
  const formattedCreditCost = tokenCost.toLocaleString('en-US');
  // The card's figure: the viewer's quote, or dollars once the price moved
  // past the quote the listing carries.
  const cashLabel = item.asset
    ? (!priceChanged && item.asset.priceQuote?.formatted) || formatUsdCents(tokenCost)
    : '';
  // Both ways to pay, for the unlock button and the checkout's price pill. The
  // recipe's chips (its badge, a text post's card) take `getAssetAccessLabel`:
  // credits alone, as the feed and the app price a recipe.
  const priceLabel = item.asset ? formatPostResourcePriceLabel(tokenCost, cashLabel) : '';
  const unlockCtaLabel = item.asset ? (isFreeUnlock ? 'Get free recipe' : `Unlock for ${priceLabel}`) : null;
  // The rail's button holds "Recipe"; the whole offer is its accessible name (B-F14).
  const reelRecipeActionLabel = hasReelUnlockAccess ? 'View recipe' : unlockCtaLabel;
  // Below the cash minimum a recipe is credits-only, and the server refuses a
  // cash order for it, as the post page's panel already knows.
  const offersCashCheckout = !isFreeUnlock && isPostResourceWebCashEligible(tokenCost);
  // Welcome and referral credits count in the balance but cannot buy a recipe,
  // so the shortfall is judged on the spendable part alone, and only when it is
  // known: an unknown figure claims nothing, and the server's answer decides.
  const spendableCredits = session?.access_token && typeof marketplaceSpendableCredits === 'number'
    ? marketplaceSpendableCredits
    : null;
  const holdsUnspendableCredits = spendableCredits !== null && typeof credits === 'number' && credits > spendableCredits;
  const hasKnownInsufficientTokens = spendableCredits !== null && spendableCredits < tokenCost;
  const offersBuyCredits = hasKnownInsufficientTokens || creditsRefusedItemId === item.id;
  const isAwaitingPayment = awaitingPaymentItemId === item.id;
  const reelUnlockNotice = isAwaitingPayment && !hasReelUnlockAccess ? RECIPE_PAYMENT_RECEIVED_MESSAGE : unlockNotice;
  const includedKindLabels = resourceKinds.map(getPostResourceKindLabel);
  const bundleCountSummary = item.asset
    ? formatPostResourceBundleCountSummary(item.asset.lockedPreview ?? null)
    : '';
  // A remix the creator sells with the recipe: offered here as in the app,
  // behind the unlock until the reader has it. Workflow and text-template
  // remixes are left out, as the server's own `canRemix` leaves them out.
  const remixNeedsUnlock = !item.canRemix
    && item.remixCapability === 'unlock_required'
    && item.remixTarget !== 'workflow'
    && item.remixTarget !== 'text_template'
    && Boolean(item.asset?.allowRemix);
  const remixIsLocked = remixNeedsUnlock && !hasReelUnlockAccess;
  // Unlisted posts take no comments (the server reads public posts only).
  const canComment = item.visibility !== 'unlisted';
  const commentsAreOpen = canComment && commentsItemId === item.id;
  const commentCount = commentCounts[item.id] ?? item.commentCount;
  const isOwnPost = Boolean(user && item.creator.id === user.id);
  const isFollowingCreator = followKey !== null && followStates[followKey] === true;
  // Signed out, Follow leads to sign-in; signed in, it waits for the answer.
  const showFollow = Boolean(item.creator.id) && !isOwnPost && (!user || isFollowStateKnown);
  const followIsPending = followKey !== null && followPendingKey === followKey;
  const followErrorMessage = followError && followError.key === followKey ? followError.message : null;
  // The body and the prompt have boxes of their own below; the lede is for a
  // post with neither, so nothing is printed twice.
  const detailsLede = item.body.trim() || item.prompt.trim() ? null : summary;
  const shouldWaitForMedia = item.postFormat !== 'text' && Boolean(activeMediaItem);
  const currentMediaKey = activeMediaItem ? getReelMediaLifecycleKey(item.id, activeMediaItem) : null;
  const currentMediaLoadState = currentMediaKey ? mediaLoadStates[currentMediaKey] ?? null : 'ready';
  const showMediaLoading = shouldWaitForMedia && currentMediaLoadState === null;
  const transition = prefersReducedMotion
    ? { duration: 0.16, ease: 'easeOut' as const }
    : { duration: 0.34, ease: [0.22, 1, 0.36, 1] as const };
  const detailsTransition = prefersReducedMotion
    ? { duration: 0.16, ease: 'easeOut' as const }
    : { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const, delay: 0.04 };

  const ensureAuthenticated = () => {
    if (session?.access_token) {
      return true;
    }

    router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(buildDetailPath(item.id)))}`);
    return false;
  };

  // An unlock made in the reel: the post page's panel opens in the details,
  // saying so and where the recipe is kept.
  const applyReelUnlock = (postId: string, bundle: ReelBundle) => {
    setUnlockSuccessItemId(postId);
    setUnlockedBundle(bundle);
    setJustUnlockedItemId(postId);
    setActiveUnlockCheckoutItemId((current) => (current === postId ? null : current));
    setUnlockError(null);
    setUnlockNotice(null);
  };

  const finishReelUnlock = async () => {
    applyReelUnlock(item.id, await fetchBundleForItem(item.id));
  };

  // The server's split of the balance stands over the page's own estimate.
  const applyServerBalance = (total: unknown, spendable: unknown) => {
    if (typeof total !== 'number') {
      return;
    }
    if (typeof spendable === 'number') {
      updateCredits(total, { marketplaceSpendableCredits: spendable });
    } else {
      updateCredits(total);
    }
  };

  // A paid recipe opens on the post it was bought for. If the reader has moved
  // on meanwhile, the reel's own access check opens it when they come back.
  const showPaidRecipe = (postId: string, bundle: ReelBundle) => {
    setAwaitingPaymentItemId((current) => (current === postId ? null : current));
    trackProductEvent('recipe_checkout_succeeded', { method: 'razorpay', post_id: postId });
    if (feedEventItemRef.current?.id === postId) {
      applyReelUnlock(postId, bundle);
    }
  };

  // The sheet took the money but the reel could not see the purchase settle.
  // Razorpay's webhook settles it, so the reel says the payment is in, holds
  // that post's buy buttons (another press would charge again), and reads the
  // recipe again until it opens, wherever the reader has scrolled to.
  const awaitPaidRecipe = (postId: string) => {
    if (unmountedRef.current) {
      return;
    }
    setUnlockError(null);
    setUnlockNotice(null);
    setAwaitingPaymentItemId(postId);
    stopBundlePollRef.current?.();
    stopBundlePollRef.current = pollBundleUntilUnlocked<ReelBundle>({
      postId,
      token: readCheckoutAccessToken,
      onUnlocked: (bundle) => {
        stopBundlePollRef.current = null;
        showPaidRecipe(postId, bundle);
      },
    });
  };

  // The recipe opened, from any of its buttons: one `resource_open` per delivery.
  const reportResourceOpen = () => sendShowcaseResourceOpenEvent({
    item,
    sourceSurface: 'showcase-reel',
    accessToken,
    feedSessionId,
    fallbackPosition: selectedIndex,
  });

  const openFreeUnlock = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      // The post page's funnel events: a recipe got in the reel counts as one got there.
      trackProductEvent('recipe_unlock_started', { method: 'free', post_id: item.id });
      setUnlockWorkingAction('free');
      setUnlockError(null);
      setUnlockNotice(null);
      const response = await fetch(`/api/posts/${item.id}/resource-bundle/unlock-free`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get the free recipe.');
      }

      await finishReelUnlock();
      trackProductEvent('recipe_unlock_succeeded', { method: 'free', post_id: item.id });
    } catch (unlockError) {
      trackProductEvent('recipe_unlock_failed', { method: 'free', post_id: item.id });
      setUnlockError(unlockError instanceof Error ? unlockError.message : 'Failed to get the free recipe.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  const openRecipe = () => {
    reportResourceOpen();
    if (isFreeUnlock) {
      void openFreeUnlock();
    } else {
      openUnlockCheckout();
    }
  };

  const startCashCheckout = async () => {
    if (!item.asset || !ensureAuthenticated()) {
      return;
    }
    const postId = item.id;

    try {
      trackProductEvent('recipe_checkout_started', { method: 'razorpay', post_id: item.id });
      setUnlockWorkingAction('cash');
      setUnlockError(null);
      setUnlockNotice(null);
      const checkoutIntentScope = `post-resource:${item.id}`;
      const clientIntentKey = getOrCreateRazorpayCheckoutIntentKey(checkoutIntentScope);
      const orderResponse = await fetch(`/api/posts/${item.id}/resource-bundle/order`, {
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
        await finishReelUnlock();
        return;
      }

      if (!window.Razorpay) {
        throw new Error('Razorpay checkout is still loading. Please try again.');
      }

      const razorpay = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Magicbooklet recipe',
        description: orderData.bundleTitle || item.asset.title,
        order_id: orderData.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          // The sheet has taken the money; from here on, nothing says "try again".
          setUnlockError(null);
          setUnlockNotice('Confirming your payment…');
          setUnlockWorkingAction('cash');
          let verification: RazorpayCheckoutVerificationResult;
          try {
            verification = await verifyRazorpayCheckoutUntilSettled({
              url: `/api/posts/${postId}/resource-bundle/verify`,
              token: readCheckoutAccessToken,
              body: response,
            });
          } catch {
            // A dropped network, a timeout, a 5xx or an ended session after
            // payment: the webhook settles this order, and the intent key
            // would reopen the paid order on the next press.
            clearRazorpayCheckoutIntentKey(checkoutIntentScope);
            setUnlockWorkingAction(null);
            awaitPaidRecipe(postId);
            return;
          }

          // The payment is bound to this order now; no later checkout may reopen it.
          clearRazorpayCheckoutIntentKey(checkoutIntentScope);
          if (verification.state === 'settled') {
            try {
              // Read with the session as it is now: the one from the click can
              // have expired in the sheet, and would read the recipe as locked.
              const bundle = await fetchBundleForItem(postId, await readCheckoutAccessToken());
              if (bundle.viewerCanAccess || bundle.viewerIsOwner) {
                showPaidRecipe(postId, bundle);
                return;
              }
            } catch {
              // Bought, but the read did not come back: the wait below reads again.
            } finally {
              setUnlockWorkingAction(null);
            }
          } else {
            setUnlockWorkingAction(null);
          }

          awaitPaidRecipe(postId);
        },
        theme: {
          color: '#34d399',
        },
      });

      razorpay.on('payment.failed', (payload: unknown) => {
        trackProductEvent('recipe_checkout_failed', { method: 'razorpay', post_id: item.id });
        const errorPayload = payload as { error?: { description?: string } } | null;
        setUnlockError(errorPayload?.error?.description || 'Payment failed. Please try again.');
      });

      razorpay.open();
    } catch (checkoutError) {
      trackProductEvent('recipe_checkout_failed', { method: 'razorpay', post_id: item.id });
      setUnlockError(checkoutError instanceof Error ? checkoutError.message : 'Failed to start checkout.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  const unlockWithTokens = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    // The spend cannot be undone: asked first, with the post page's words.
    // (A known shortfall never gets here: the button is held and "Buy credits" shows.)
    const confirmedPriceCredits = tokenCost;
    const confirmed = await requestConfirmation({
      title: 'Unlock this recipe?',
      message: `${formattedCreditCost} credits will come off your balance.`,
      confirmLabel: `Unlock for ${formattedCreditCost} credits`,
    });
    if (!confirmed) {
      return;
    }

    try {
      trackProductEvent('recipe_unlock_started', { method: 'credits', post_id: item.id });
      setUnlockWorkingAction('tokens');
      setUnlockError(null);
      setUnlockNotice(null);
      // The price the reader said yes to: nothing is charged if it has moved (S3).
      const response = await fetch(`/api/posts/${item.id}/resource-bundle/unlock-with-credits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ expectedPriceCredits: confirmedPriceCredits }),
      });
      const data = await response.json();

      if (!response.ok || !data?.success) {
        if (response.status === 402 && data?.code === 'INSUFFICIENT_CREDITS') {
          // The server's count is what refused, so it replaces the page's.
          applyServerBalance(data.remainingCredits, data.marketplaceSpendableCredits);
          setCreditsRefusedItemId(item.id);
        }
        if (response.status === 409 && data?.code === 'RESOURCE_PRICE_CHANGED' && typeof data.priceCredits === 'number') {
          // Nothing was charged: the reel shows the price the server holds,
          // and the reader confirms again at it.
          const priceCredits = Math.max(0, Math.round(data.priceCredits));
          setPriceChanges((current) => ({
            ...current,
            [item.id]: { fromPriceCredits: listedPriceCredits, priceCredits },
          }));
          trackProductEvent('recipe_unlock_failed', { method: 'credits', post_id: item.id });
          setUnlockError(`The price changed to ${priceCredits.toLocaleString('en-US')} credits.`);
          return;
        }
        throw new Error(data.error || 'Failed to unlock with credits.');
      }

      applyServerBalance(data.credits, data.marketplaceSpendableCredits);

      await finishReelUnlock();
      trackProductEvent('recipe_unlock_succeeded', { method: 'credits', post_id: item.id });
    } catch (unlockError) {
      trackProductEvent('recipe_unlock_failed', { method: 'credits', post_id: item.id });
      setUnlockError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock with credits.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  // Follow from the reel, credited to the post and the delivery that showed
  // it, as the app's reel sends it. The request is the creator page's.
  const toggleFollow = async () => {
    const targetCreatorId = item.creator.id;
    if (!targetCreatorId || !ensureAuthenticated() || !user || !session?.access_token) {
      return;
    }
    if (targetCreatorId === user.id) {
      return;
    }

    const key = `${user.id}:${targetCreatorId}`;
    const wasFollowing = followStates[key] === true;
    const nextFollowing = !wasFollowing;
    setFollowStates((current) => ({ ...current, [key]: nextFollowing }));
    setFollowPendingKey(key);
    setFollowError(null);

    try {
      const response = await fetch('/api/profile/follow', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          followingId: targetCreatorId,
          following: nextFollowing,
          postId: item.id,
          deliveryId: item.recommendation?.deliveryId ?? null,
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to update follow state');
      }

      const data = await response.json() as { following?: unknown };
      const confirmedFollowing = typeof data.following === 'boolean' ? data.following : nextFollowing;
      setFollowStates((current) => ({ ...current, [key]: confirmedFollowing }));
    } catch {
      setFollowStates((current) => ({ ...current, [key]: wasFollowing }));
      setFollowError({ key, message: 'Could not update follow. Please try again.' });
    } finally {
      setFollowPendingKey((current) => current === key ? null : current);
    }
  };

  const toggleComments = () => {
    if (commentsAreOpen) {
      setCommentsItemId(null);
      return;
    }

    setCommentsItemId(item.id);
    // The thread is the last thing in the details: bring it into view.
    window.requestAnimationFrame(() => {
      const scroller = detailsScrollerRef.current;
      const section = commentsSectionRef.current;
      if (!scroller || !section) return;
      scroller.scrollTo({
        top: scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    });
  };

  const recordCommentCount = (postId: string, nextCount: number) => {
    setCommentCounts((current) => current[postId] === nextCount ? current : { ...current, [postId]: nextCount });
    onCommentCountChange?.(postId, nextCount);
  };

  const copyPrompt = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopiedPromptItemId(item.id);
    } catch {
      // Refused by the browser: the prompt is still on screen to select.
    }
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    // A finger scrolling the details (a thread, a long prompt) is not a swipe
    // to another post, as the wheel there is not.
    if (target?.closest('[data-reel-scroll-region="details"]')) {
      touchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;

    if (!start) {
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = (touch?.clientX ?? start.x) - start.x;
    const deltaY = (touch?.clientY ?? start.y) - start.y;

    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      return;
    }

    if (Math.abs(deltaY) < 60) {
      return;
    }

    if (deltaY < 0) {
      goNext();
      return;
    }

    goPrevious();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) {
      return;
    }

    // `Element`: the details scroll under a resting pointer, so a wheel often
    // starts over one of their icons, an <svg> that is not an HTMLElement.
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-reel-scroll-region="details"]')) {
      return;
    }

    if (Math.abs(event.deltaY) < 36 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) {
      return;
    }

    event.preventDefault();

    const now = window.performance.now();
    if (now - wheelCooldownRef.current < 650) {
      return;
    }

    if (event.deltaY > 0 && nextItem) {
      wheelCooldownRef.current = now;
      goNext();
      return;
    }

    if (event.deltaY < 0 && previousItem) {
      wheelCooldownRef.current = now;
      goPrevious();
    }
  };

  const renderCompactUnlockCard = () => {
    if (!item.asset) {
      return null;
    }

    return (
      <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Recipe</div>
            <h3 className="mt-2 text-base font-semibold text-white">{item.asset.title}</h3>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300 px-2.5 py-1 text-xs font-bold text-slate-950">
            {isFreeUnlock ? 'Free' : priceLabel}
          </span>
        </div>

        {includedKindLabels.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {includedKindLabels.map((label) => (
              <span
                key={`${item.id}:${label}`}
                className="rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-medium text-emerald-50"
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}

        {bundleCountSummary ? (
          <p className="mt-3 text-sm leading-6 text-emerald-50/75">
            Includes {bundleCountSummary}.
          </p>
        ) : null}

        {isFreeUnlock ? (
          <button
            type="button"
            onClick={() => void openFreeUnlock()}
            disabled={unlockWorkingAction !== null}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {unlockWorkingAction === 'free' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {unlockWorkingAction === 'free' ? 'Adding recipe…' : 'Get free recipe'}
          </button>
        ) : (
          <div className="mt-4 grid gap-2">
            {offersCashCheckout ? (
              <button
                type="button"
                onClick={() => void startCashCheckout()}
                disabled={unlockWorkingAction !== null || isAwaitingPayment}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {unlockWorkingAction === 'cash' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
                {`Pay ${cashLabel}`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void unlockWithTokens()}
              disabled={unlockWorkingAction !== null || hasKnownInsufficientTokens || isAwaitingPayment}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/25 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {unlockWorkingAction === 'tokens' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {`Use ${formattedCreditCost} credits`}
            </button>
            {!session?.access_token || spendableCredits !== null || offersBuyCredits ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-50/75">
                {!session?.access_token ? <span>Sign in to see your credit balance</span> : null}
                {spendableCredits !== null ? <span>{`${spendableCredits.toLocaleString()} credits available`}</span> : null}
                {holdsUnspendableCredits ? <span>{UNSPENDABLE_CREDITS_NOTE}</span> : null}
                {offersBuyCredits ? (
                  // With the way back to the post's recipe (B-F8).
                  <Link href={buildRecipeTopUpHref(buildDetailPath(item.id))} className="font-semibold text-emerald-200 transition hover:text-emerald-100">
                    Buy credits
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {reelUnlockNotice ? (
          <div className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-50">
            {reelUnlockNotice}
          </div>
        ) : null}

        {unlockError ? (
          <div className="mt-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {unlockError}
          </div>
        ) : null}
      </div>
    );
  };

  const renderMedia = () => {
    if (item.postFormat === 'text') {
      return (
        <div className="flex h-full w-full items-center justify-center p-4 sm:p-6">
          <TextPostPreviewCard
            title={item.title}
            summary={summary}
            sourceLabel={item.sourceTool || item.model}
            dateLabel={dateLabel}
            saveCount={item.saveCount}
            remixCount={item.remixCount}
            unlockLabel={item.asset ? getAssetAccessLabel(item.asset, { isOwner: isOwnPost }) : null}
            resourceKinds={resourceKinds}
            showStats={false}
            className="w-full max-w-xl border-white/10 bg-zinc-950/90"
            titleClassName="text-2xl sm:text-3xl"
            summaryClassName="line-clamp-none text-base leading-8"
          />
        </div>
      );
    }

    if (mediaItems.length > 0) {
      return (
        <ShowcaseMediaCarousel
          key={`${item.id}:${activeMediaIndex}`}
          mediaItems={mediaItems}
          title={item.title}
          mode="reel"
          autoPlayVideo={currentMediaLoadState !== 'error'}
          initialIndex={activeMediaIndex}
          className="h-full"
          onIndexChange={(index) => {
            setActiveMediaIndex(index);
            onMediaIndexChange?.(index);
          }}
          onMediaReady={(readyItem) => {
            setMediaLoadState(getReelMediaLifecycleKey(item.id, readyItem), 'ready');
          }}
          onMediaError={(failedItem) => {
            setMediaLoadState(getReelMediaLifecycleKey(item.id, failedItem), 'error');
          }}
          onVideoProgress={(progress, durationMs) => {
            const tracker = mediaProgressTrackerRef.current;
            if (tracker?.record(progress, durationMs)) {
              flushMediaProgressRef.current();
            }
          }}
          onMediaRetry={(retryItem) => {
            setMediaLoadState(getReelMediaLifecycleKey(item.id, retryItem), null);
          }}
        />
      );
    }

    return (
      <div className="flex h-full w-full items-center justify-center text-zinc-500">
        No media preview
      </div>
    );
  };

  return (
    <div
      ref={attachReelDialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${originLabel} reel viewer`}
      className="fixed inset-0 z-[90] overflow-hidden bg-[#050506] text-white"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {item.asset && isUnlockCheckoutOpen && offersCashCheckout ? (
        <Script id="showcase-reel-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />
      ) : null}

      {/*
        Above the body below (z-10): the ⋯ menu hangs from this bar over the
        media and the details rail. At the body's own level the body, which
        comes later, was drawn over the menu, and no row could be seen or pressed.
      */}
      <header className="relative z-20 flex h-14 items-center justify-between gap-3 border-b border-white/8 bg-black/40 px-3 backdrop-blur-xl sm:px-5">
        <button
          ref={reelCloseButtonRef}
          type="button"
          onClick={handleClose}
          className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
          {originLabel}
        </button>

        <div className="min-w-0 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">{originLabel} reel</div>
          <div className="text-xs text-zinc-300">
            {selectedIndex + 1}
            {!hasMoreItems && !isLoadingMoreItems ? ` / ${items.length}` : null}
            <span className="sr-only">
              {hasMoreItems || isLoadingMoreItems ? '. More posts are available.' : ` of ${items.length}.`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 sm:inline-flex">Arrow keys</span>
          {onFeedback || onReportContent || onReportUser || onBlockUser ? (
            <ShowcaseFeedbackMenu
              itemTitle={item.title}
              creator={item.creator}
              canHideCreator={Boolean(item.creator.id && item.creator.id !== user?.id)}
              sessionOnly={!user}
              onSelect={onFeedback ? (action) => onFeedback(item, action) : undefined}
              // Not on the viewer's own post, as on a feed card and an Explore tile.
              onReportContent={onReportContent && !(user && item.creator.id === user.id)
                ? () => void onReportContent(item)
                : undefined}
              onReportUser={onReportUser ? () => void onReportUser(item) : undefined}
              onBlockUser={onBlockUser ? () => void onBlockUser(item) : undefined}
              buttonClassName="h-10 w-10 bg-white/[0.04] shadow-none"
            />
          ) : null}
        </div>
      </header>

      {/*
        The media column caps at max-w-5xl, so past ~1400px it just accumulates
        dead space. Let the details rail take that slack instead of staying
        pinned at 390px — below xl it keeps the original fixed width.
      */}
      <div className="relative z-10 grid h-[calc(100dvh-3.5rem)] min-h-0 grid-rows-[minmax(0,1fr)_auto_minmax(180px,0.45fr)] gap-3 px-3 pb-3 pt-3 lg:grid-cols-[minmax(0,1fr)_78px_390px] lg:grid-rows-none lg:px-5 xl:grid-cols-[minmax(0,1fr)_78px_clamp(390px,27vw,520px)]">
        <section className="relative min-h-0 overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_26px_90px_rgba(0,0,0,0.5)]">
          <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-semibold text-zinc-100 backdrop-blur-md">
              {mediaTypeLabel}
            </span>
            <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur-md">
              {dateLabel}
            </span>
          </div>

          <div
            className="relative h-full w-full overflow-hidden"
            aria-busy={showMediaLoading}
          >
            <AnimatePresence mode="wait" custom={transitionDirection}>
              <motion.div
                key={item.id}
                custom={transitionDirection}
                variants={mediaVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={transition}
                className="absolute inset-0 h-full w-full"
              >
                {renderMedia()}
              </motion.div>
            </AnimatePresence>

            <AnimatePresence>
              {showMediaLoading ? (
                <motion.div
                  key={`${item.id}:media-loading`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.1 : 0.18 }}
                  className="pointer-events-none absolute inset-0 z-[5] bg-black"
                  data-showcase-media-state="loading"
                  role="status"
                  aria-live="polite"
                >
                  <span className="sr-only">Loading media</span>
                  <div
                    aria-hidden="true"
                    className={prefersReducedMotion
                      ? 'absolute inset-0 bg-white/[0.025]'
                      : 'absolute inset-0 bg-[linear-gradient(110deg,transparent,rgba(255,255,255,0.08),transparent)] [animation:skeleton-shimmer_1.35s_ease-in-out_infinite]'}
                  />
                  <div className="absolute inset-x-[18%] top-1/2 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {item.postFormat !== 'text' ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-4 lg:hidden">
              <div className="max-w-[80%]">
                <h2 className="line-clamp-2 text-lg font-semibold text-white">{item.title}</h2>
                <p className="mt-1 line-clamp-2 text-sm leading-5 text-zinc-300">{summary}</p>
              </div>
            </div>
          ) : null}

        </section>

        <aside className="flex min-w-0 items-center justify-center gap-2 overflow-x-auto rounded-[24px] border border-white/10 bg-white/[0.035] p-2 backdrop-blur-xl lg:flex-col lg:overflow-visible lg:border-0 lg:bg-transparent lg:p-0">
          <div
            role="group"
            aria-label="Browse posts"
            data-showcase-post-navigation
            className="hidden shrink-0 items-center gap-1 rounded-[20px] border border-white/10 bg-white/[0.035] p-1 sm:flex lg:flex-col"
          >
            <button
              type="button"
              onClick={goPrevious}
              disabled={!previousItem}
              aria-label="Previous post"
              className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-black/45 text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp size={16} className="h-4 w-4 shrink-0" />
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!nextItem && !hasMoreItems}
              aria-busy={!nextItem && hasMoreItems && isLoadingMoreItems}
              aria-label="Next post"
              className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-black/45 text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {!nextItem && hasMoreItems && isLoadingMoreItems ? (
                <Loader2 size={16} className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <ArrowDown size={16} className="h-4 w-4 shrink-0" />
              )}
            </button>
          </div>

          <div aria-hidden="true" className="hidden h-8 w-px shrink-0 bg-white/10 sm:block lg:h-px lg:w-10" />

          <button
            type="button"
            onClick={() => void onToggleSave(item.id)}
            aria-pressed={isSaved}
            aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${item.title}`}
            className={`inline-flex h-14 w-16 max-w-16 shrink-0 flex-none flex-col items-center justify-center gap-1 rounded-2xl border text-xs font-semibold transition lg:h-[70px] lg:w-[70px] lg:max-w-[70px] ${
              isSaved
                ? 'border-[var(--ui-primary)]/35 bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]'
                : 'border-white/10 bg-white/[0.05] text-zinc-100 hover:bg-white/[0.08]'
            }`}
          >
            <Heart size={20} className={`h-5 w-5 shrink-0 ${isSaved ? 'fill-[var(--ui-primary)] text-[var(--ui-primary)]' : ''}`} />
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${item.id}:${item.saveCount}`}
                initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
                transition={{ duration: 0.16 }}
              >
                {item.saveCount}
              </motion.span>
            </AnimatePresence>
          </button>

          {canComment ? (
            <button
              type="button"
              onClick={toggleComments}
              aria-expanded={commentsAreOpen}
              aria-controls={commentsAreOpen ? 'showcase-reel-comments' : undefined}
              aria-label={`${commentsAreOpen ? 'Hide' : 'Show'} comments on ${item.title} (${commentCount})`}
              className={`inline-flex h-14 w-16 max-w-16 shrink-0 flex-none flex-col items-center justify-center gap-1 rounded-2xl border text-xs font-semibold transition lg:h-[70px] lg:w-[70px] lg:max-w-[70px] ${
                commentsAreOpen
                  ? 'border-white/25 bg-white/[0.12] text-white'
                  : 'border-white/10 bg-white/[0.05] text-zinc-100 hover:bg-white/[0.08]'
              }`}
            >
              <MessageCircle size={20} className="h-5 w-5 shrink-0" />
              <span>{formatCompactCount(commentCount)}</span>
            </button>
          ) : null}

          <PublicShareButton
            generationId={item.id}
            title={item.title}
            description={item.body || item.prompt}
            sourceSurface="showcase-reel"
            accessToken={accessToken ?? null}
            viewerIsOwner={Boolean(item.creator.id && item.creator.id === user?.id)}
            onShared={() => {
              void sendShowcaseFeedEvent({
                item,
                eventType: 'share',
                sourceSurface: 'showcase-reel',
                accessToken,
                feedSessionId,
                fallbackPosition: selectedIndex,
              }).catch(() => undefined);
            }}
            label="Share"
            className="inline-flex h-14 w-16 max-w-16 shrink-0 flex-none flex-col items-center justify-center gap-1 rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.08] lg:h-[70px] lg:w-[70px] lg:max-w-[70px]"
          />

          {item.asset ? (
            <button
              type="button"
              onClick={() => {
                if (hasReelUnlockAccess) {
                  reportResourceOpen();
                  recipePanelRef.current?.scrollIntoView({
                    block: 'start',
                    behavior: prefersReducedMotion ? 'auto' : 'smooth',
                  });
                } else {
                  openRecipe();
                }
              }}
              disabled={unlockWorkingAction !== null}
              aria-label={reelRecipeActionLabel ?? 'Open recipe'}
              className="inline-flex h-14 w-16 max-w-16 shrink-0 flex-none flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/25 bg-emerald-500/12 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300/45 hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-60 lg:h-[70px] lg:w-[70px] lg:max-w-[70px]"
            >
              {unlockWorkingAction === 'free'
                ? <Loader2 size={20} className="h-5 w-5 shrink-0 animate-spin" />
                : <ShoppingBag size={20} className="h-5 w-5 shrink-0" />}
              <span>{unlockWorkingAction === 'free' ? 'Adding…' : 'Recipe'}</span>
            </button>
          ) : null}

          {item.canRemix || remixNeedsUnlock ? (
            <button
              type="button"
              // Until the reader has the recipe, the tap gets it (free) or
              // opens its checkout; with it, the tap remixes.
              aria-label={remixIsLocked ? `Remix: unlock the recipe for ${item.title} first` : undefined}
              onClick={() => {
                if (remixIsLocked) {
                  openRecipe();
                  return;
                }
                if (remixWorkingItemId) return;
                setRemixError(null);
                setRemixWorkingItemId(item.id);
                void Promise.resolve(onRemix(item.id))
                  .catch((error: unknown) => {
                    setRemixError(
                      error instanceof Error && error.message
                        ? error.message
                        : 'Could not start the remix. Please try again.',
                    );
                  })
                  .finally(() => setRemixWorkingItemId(null));
              }}
              disabled={remixWorkingItemId !== null || (remixIsLocked && unlockWorkingAction !== null)}
              className="ui-focus-ring inline-flex h-14 w-16 max-w-16 shrink-0 flex-none flex-col items-center justify-center gap-1 rounded-2xl border border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary)] text-xs font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-60 lg:h-[70px] lg:w-[70px] lg:max-w-[70px]"
            >
              {remixWorkingItemId === item.id
                ? <Loader2 size={20} className="h-5 w-5 shrink-0 animate-spin" />
                : remixIsLocked
                  ? <LockKeyhole size={20} className="h-5 w-5 shrink-0" />
                  : <Wand2 size={20} className="h-5 w-5 shrink-0" />}
              <span>{remixWorkingItemId === item.id ? 'Starting…' : 'Remix'}</span>
            </button>
          ) : null}
        </aside>

        <section
          data-reel-scroll-region="details"
          className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.92),rgba(8,8,10,0.94))] shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl"
        >
          <div className="shrink-0 flex items-center justify-between border-b border-white/8 px-5 py-4">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              <MessageSquareText className="h-4 w-4" />
              Details
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300">
              {mediaTypeLabel}
            </span>
          </div>

          <div
            ref={detailsScrollerRef}
            className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-5 pb-6"
          >
            {loadMoreError ? (
              <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-rose-300/25 bg-rose-400/10 px-4 py-3">
                <p className="text-sm text-rose-100">{loadMoreError}</p>
                <button
                  type="button"
                  onClick={() => void onLoadMoreItems()}
                  className="ui-focus-ring inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border border-rose-300/25 bg-rose-400/10 px-3 text-sm font-bold text-rose-100 transition hover:bg-rose-400/15"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Retry
                </button>
              </div>
            ) : null}
            {remixError ? (
              <div role="alert" className="mb-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {remixError}
              </div>
            ) : null}
            <AnimatePresence mode="wait" custom={transitionDirection}>
              <motion.div
                key={item.id}
                custom={transitionDirection}
                variants={detailsVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={detailsTransition}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <CreatorIdentity creator={item.creator} prefetch={false} />
                  </div>
                  {showFollow ? (
                    <button
                      type="button"
                      onClick={() => void toggleFollow()}
                      disabled={followIsPending}
                      aria-label={`${isFollowingCreator ? 'Following' : 'Follow'} ${item.creator.name}`}
                      aria-pressed={isFollowingCreator}
                      aria-busy={followIsPending}
                      className={`ui-focus-ring inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-70 ${
                        isFollowingCreator
                          ? 'border border-white/15 bg-white/10 text-white hover:bg-white/15'
                          : 'bg-white text-black hover:bg-zinc-200'
                      }`}
                    >
                      {followIsPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                      {isFollowingCreator ? 'Following' : 'Follow'}
                    </button>
                  ) : null}
                </div>
                {followErrorMessage ? (
                  <p role="alert" className="mt-2 text-xs text-rose-300">{followErrorMessage}</p>
                ) : null}

                <h2 className="mt-5 text-2xl font-semibold tracking-tight text-white">
                  {item.title}
                </h2>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {dateLabel}
                  </span>
                  <span className="capitalize">{item.category}</span>
                  {item.sourceTool ? <span>{item.sourceTool}</span> : null}
                </div>

                {detailsLede ? (
                  <p className="mt-5 text-sm leading-7 text-zinc-300">
                    {detailsLede}
                  </p>
                ) : null}

                {item.asset && !isUnlockCheckoutOpen && !hasReelUnlockAccess ? (
                  <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Recipe</div>
                        <h3 className="mt-2 text-base font-semibold text-white">{item.asset.title}</h3>
                      </div>
                      <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300 px-2.5 py-1 text-xs font-bold text-slate-950">
                        {getAssetAccessLabel(item.asset, { isOwner: isOwnPost })}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-emerald-50/80">
                      {item.asset.previewText || 'Open reusable parts, prompts, files, or workflow notes from this post.'}
                    </p>
                    {resourceKinds.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {resourceKinds.map((kind) => (
                          <span
                            key={`${item.id}:${kind}`}
                            className="rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-medium text-emerald-50"
                          >
                            {getPostResourceKindLabel(kind)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={openRecipe}
                      disabled={unlockWorkingAction !== null}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {unlockWorkingAction === 'free'
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <LockKeyhole className="h-4 w-4" />}
                      {unlockWorkingAction === 'free' ? 'Adding recipe…' : unlockCtaLabel}
                    </button>
                  </div>
                ) : null}

                {item.asset && isUnlockCheckoutOpen && !hasReelUnlockAccess ? (
                  renderCompactUnlockCard()
                ) : null}

                {item.asset && hasReelUnlockAccess && unlockedBundle ? (
                  // The post page's own panel, whole (B-F1): every item, files
                  // to open and save, links to follow, settings as keys and
                  // values. The partial card it replaces showed the first
                  // prompt and note alone.
                  <div ref={recipePanelRef} className="mt-5 scroll-mt-4 rounded-[22px] border border-emerald-300/20 bg-black/30 p-4">
                    <PostResourceBundlePanel
                      key={item.id}
                      {...buildRecipePanelProps(toReelRecipeSource(item.asset, unlockedBundle), {
                        postId: item.id,
                        mediaItems,
                        displayTitle: item.title,
                        remixIncluded: Boolean(item.asset.allowRemix) && (item.canRemix || remixNeedsUnlock),
                        returnPath: buildDetailPath(item.id),
                      })}
                      announceUnlock={justUnlockedItemId === item.id}
                    />
                  </div>
                ) : null}

                {item.body.trim() ? (
                  <div className="mt-5 rounded-[20px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Note</div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300">
                      {item.body}
                    </p>
                  </div>
                ) : null}

                {item.prompt.trim() ? (
                  <div className="mt-5 rounded-[20px] border border-white/8 bg-black/30 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        {item.postFormat === 'text' ? 'Workflow notes' : 'Prompt'}
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyPrompt()}
                        aria-label={copiedPromptItemId === item.id ? 'Copied' : `Copy the ${item.postFormat === 'text' ? 'workflow notes' : 'prompt'}`}
                        className="ui-focus-ring rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.08]"
                      >
                        {copiedPromptItemId === item.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="mt-3 max-h-44 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-300 [overflow-wrap:anywhere] app-scrollbar">
                      {item.prompt}
                    </p>
                  </div>
                ) : null}

                <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                  <Link
                    href={buildDetailPath(item.id)}
                    prefetch={false}
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Post details
                  </Link>
                  <Link
                    href="/create"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                  >
                    <Sparkles className="h-4 w-4" />
                    Create your own
                  </Link>
                </div>

                {commentsAreOpen ? (
                  <div
                    id="showcase-reel-comments"
                    ref={commentsSectionRef}
                    className="mt-6 border-t border-white/8 pt-5"
                  >
                    <PostComments
                      postId={item.id}
                      postCreatorId={item.creator.id}
                      commentCount={commentCount}
                      // Credited to the ranked delivery that showed the post, as a feed card's thread is.
                      deliveryId={item.recommendation?.deliveryId ?? null}
                      onCommentCountChange={(nextCount) => recordCommentCount(item.id, nextCount)}
                    />
                  </div>
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </section>
      </div>
    </div>
  );
}
