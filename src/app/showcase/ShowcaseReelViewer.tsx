'use client';

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
  MessageSquareText,
  ShoppingBag,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import PublicShareButton from '@/app/components/PublicShareButton';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useAuth } from '@/app/components/AuthProvider';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import {
  formatPostResourceBundleCountSummary,
  getBundleAccessLabel,
  getPostResourceKindLabel,
  isPostResourceKind,
  type PostResourceAttachment,
  type PostResourceItem,
  type PostResourceKind,
  type PostResourceSection,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { getCurrentInternalPath } from '@/lib/share';
import { isGenerationRecipeAssetId, type ShowcaseFeedItem, type ShowcaseMediaItem } from '@/lib/showcase';

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
  savingItemIds: Set<string>;
  accessToken?: string | null;
  hasMoreItems: boolean;
  isLoadingMoreItems: boolean;
  initialMediaIndex?: number;
  onLoadMoreItems: () => void | Promise<void>;
  onClose: () => void;
  onSelectItemId: (id: string) => void;
  onMediaIndexChange?: (index: number) => void;
  onToggleSave: (id: string) => void | Promise<void>;
  onRemix: (id: string) => void | Promise<void>;
  buildDetailPath: (id: string, section?: string) => string;
}

type ReelTransitionDirection = 'next' | 'previous' | 'neutral';
type ReelUnlockAction = 'free' | 'cash' | 'tokens' | null;

interface ReelBundleResources {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
  sections?: PostResourceSection[];
  items?: PostResourceItem[];
}

interface ReelBundleRefreshPayload {
  viewerCanAccess: boolean;
  viewerIsOwner: boolean;
  resources: ReelBundleResources | null;
}

interface ActiveReferencePreview {
  src: string;
  alt: string;
}

function getItemResourceKinds(item: ShowcaseFeedItem): PostResourceKind[] {
  return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
  if (isGenerationRecipeAssetId(asset.id)) {
    return 'Public recipe';
  }

  if (asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: asset.accessMode,
      priceQuote: asset.priceQuote,
    });
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

function getAssetPurchaseCtaLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
  if (isGenerationRecipeAssetId(asset.id)) {
    return 'View recipe';
  }

  if (asset.accessMode === 'free' || asset.priceUsdCents === 0) {
    return 'Open free unlock';
  }

  return `Unlock for ${asset.priceQuote?.formatted ?? getBundleAccessLabel(asset.accessMode, asset.priceUsdCents).replace(/\s+unlock$/i, '')}`;
}

function getItemSummary(item: ShowcaseFeedItem): string {
  if (item.asset && isGenerationRecipeAssetId(item.asset.id)) {
    const kinds = getItemResourceKinds(item);
    const bundleCountSummary = formatPostResourceBundleCountSummary(item.asset.lockedPreview ?? null);

    if (bundleCountSummary) {
      return `Creation recipe includes ${bundleCountSummary}.`;
    }

    if (kinds.length > 0) {
      return `Creation recipe includes ${kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase()).join(', ')}.`;
    }

    return item.asset.previewText || 'Creation recipe is available below.';
  }

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
      ? `Unlock includes ${bundleCountSummary}.`
      : kinds.length > 0
      ? `Unlock includes ${kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase()).join(', ')}.`
      : 'Reusable unlock attached.';
  }

  return `${item.category === 'text' ? 'Tip' : item.category} by ${item.creator.name}`;
}

function getMediaTypeLabel(item: ShowcaseFeedItem): string {
  if (item.postFormat === 'text' || item.category === 'text') {
    return 'Tip / note';
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

function getItemMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
  if (item.mediaItems?.length) {
    return item.mediaItems;
  }

  if (!item.mediaUrl || !item.mediaKind) {
    return [];
  }

  return [{
    id: `${item.id}:cover`,
    url: item.mediaUrl,
    mediaKind: item.mediaKind,
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

export default function ShowcaseReelViewer({
  isOpen,
  items,
  selectedItemId,
  savedItemIds,
  savingItemIds,
  accessToken,
  hasMoreItems,
  isLoadingMoreItems,
  initialMediaIndex = 0,
  onLoadMoreItems,
  onClose,
  onSelectItemId,
  onMediaIndexChange,
  onToggleSave,
  onRemix,
  buildDetailPath,
}: ShowcaseReelViewerProps) {
  const router = useRouter();
  const { session, credits, updateCredits } = useAuth();
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const wheelCooldownRef = useRef(0);
  const detailsScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingAdvanceAfterLoadRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const [transitionDirection, setTransitionDirection] = useState<ReelTransitionDirection>('neutral');
  const [activeMediaIndex, setActiveMediaIndex] = useState(initialMediaIndex);
  const [loadedMediaKeys, setLoadedMediaKeys] = useState<Set<string>>(new Set());
  const [activeUnlockCheckoutItemId, setActiveUnlockCheckoutItemId] = useState<string | null>(null);
  const [unlockWorkingAction, setUnlockWorkingAction] = useState<ReelUnlockAction>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockSuccessItemId, setUnlockSuccessItemId] = useState<string | null>(null);
  const [unlockedResources, setUnlockedResources] = useState<ReelBundleResources | null>(null);
  const [showUnlockedDetails, setShowUnlockedDetails] = useState(false);
  const [publicRecipeItemId, setPublicRecipeItemId] = useState<string | null>(null);
  const [publicRecipeResources, setPublicRecipeResources] = useState<ReelBundleResources | null>(null);
  const [publicRecipeLoadingItemId, setPublicRecipeLoadingItemId] = useState<string | null>(null);
  const [publicRecipeError, setPublicRecipeError] = useState<string | null>(null);
  const [resourceFileUrls, setResourceFileUrls] = useState<Record<string, string>>({});
  const [activeReferencePreview, setActiveReferencePreview] = useState<ActiveReferencePreview | null>(null);
  const selectedIndex = useMemo(
    () => selectedItemId ? items.findIndex((item) => item.id === selectedItemId) : -1,
    [items, selectedItemId]
  );
  const item = selectedIndex >= 0 ? items[selectedIndex] : null;
  const previousItem = selectedIndex > 0 ? items[selectedIndex - 1] : null;
  const nextItem = selectedIndex >= 0 && selectedIndex < items.length - 1 ? items[selectedIndex + 1] : null;
  const selectedAssetId = item?.asset?.id ?? null;
  const isPublicRecipeAsset = Boolean(selectedAssetId && isGenerationRecipeAssetId(selectedAssetId));
  const mediaItems = item ? getItemMediaItems(item) : [];
  const activeMediaItem = mediaItems[Math.min(activeMediaIndex, Math.max(0, mediaItems.length - 1))] ?? mediaItems[0] ?? null;

  const moveToItem = useCallback((targetItem: ShowcaseFeedItem, direction: ReelTransitionDirection) => {
    setActiveUnlockCheckoutItemId(null);
    setUnlockWorkingAction(null);
    setUnlockError(null);
    setShowUnlockedDetails(false);
    setActiveMediaIndex(0);
    setTransitionDirection(direction);
    onSelectItemId(targetItem.id);
  }, [onSelectItemId]);

  useEffect(() => {
    const clampedIndex = Math.min(Math.max(initialMediaIndex, 0), Math.max(0, mediaItems.length - 1));
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

    if (hasMoreItems) {
      requestMoreItems(true);
    }
  }, [hasMoreItems, moveToItem, nextItem, requestMoreItems]);

  const handleClose = useCallback(() => {
    setActiveUnlockCheckoutItemId(null);
    setUnlockWorkingAction(null);
    setUnlockError(null);
    setShowUnlockedDetails(false);
    setTransitionDirection('neutral');
    onClose();
  }, [onClose]);

  const fetchBundleForItem = useCallback(async (postId: string) => {
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

    return data.bundle as ReelBundleRefreshPayload;
  }, [session?.access_token]);

  const openUnlockCheckout = () => {
    if (!item?.asset) {
      return;
    }

    if (isGenerationRecipeAssetId(item.asset.id)) {
      detailsScrollerRef.current?.scrollTo({
        top: 220,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
      return;
    }

    setActiveUnlockCheckoutItemId(item.id);
    setUnlockError(null);
    setShowUnlockedDetails(false);
    window.requestAnimationFrame(() => {
      detailsScrollerRef.current?.scrollTo({
        top: 0,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    });
  };

  const markMediaReady = useCallback((mediaKey: string) => {
    setLoadedMediaKeys((currentKeys) => {
      if (currentKeys.has(mediaKey)) {
        return currentKeys;
      }

      const nextKeys = new Set(currentKeys);
      nextKeys.add(mediaKey);
      return nextKeys;
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

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    detailsScrollerRef.current?.scrollTo({ top: 0 });
  }, [isOpen, item?.id]);

  useEffect(() => {
    if (!isOpen || selectedIndex < 0 || !nextItem || !hasMoreItems || isLoadingMoreItems) {
      return;
    }

    if (items.length - selectedIndex <= 3) {
      void onLoadMoreItems();
    }
  }, [hasMoreItems, isLoadingMoreItems, isOpen, items.length, nextItem, onLoadMoreItems, selectedIndex]);

  useEffect(() => {
    if (!pendingAdvanceAfterLoadRef.current || !nextItem) {
      return;
    }

    pendingAdvanceAfterLoadRef.current = false;
    onSelectItemId(nextItem.id);
  }, [nextItem, onSelectItemId]);

  useEffect(() => {
    if (!isOpen || !item?.id || !isPublicRecipeAsset) {
      return;
    }

    let cancelled = false;

    setPublicRecipeLoadingItemId(item.id);
    setPublicRecipeError(null);

    void fetchBundleForItem(item.id)
      .then((bundle) => {
        if (cancelled) {
          return;
        }

        if (bundle.viewerCanAccess && bundle.resources) {
          setPublicRecipeItemId(item.id);
          setPublicRecipeResources(bundle.resources);
          return;
        }

        setPublicRecipeItemId(null);
        setPublicRecipeResources(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setPublicRecipeError(error instanceof Error ? error.message : 'Failed to load recipe.');
      })
      .finally(() => {
        if (!cancelled) {
          setPublicRecipeLoadingItemId(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchBundleForItem, isOpen, isPublicRecipeAsset, item?.id]);

  const activeAccessibleResources =
    item && unlockSuccessItemId === item.id
      ? unlockedResources
      : item && publicRecipeItemId === item.id
        ? publicRecipeResources
        : null;

  useEffect(() => {
    const storagePaths = Array.from(new Set([
      ...(activeAccessibleResources?.items ?? [])
        .map((resourceItem) => resourceItem.storagePath)
        .filter((storagePath): storagePath is string => Boolean(storagePath)),
      ...(activeAccessibleResources?.attachments ?? [])
        .map((attachment) => attachment.storagePath)
        .filter((storagePath): storagePath is string => Boolean(storagePath)),
    ]));

    setResourceFileUrls({});

    if (!item?.id || storagePaths.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(storagePaths.map(async (storagePath) => {
      const response = await fetch(`/api/posts/${item.id}/resource-bundle/file-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          storagePath,
        }),
      });
      const data = await response.json();

      if (!response.ok || typeof data?.signedUrl !== 'string') {
        return null;
      }

      return [storagePath, data.signedUrl] as const;
    }))
      .then((entries) => {
        if (cancelled) {
          return;
        }

        setResourceFileUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
      })
      .catch(() => {
        if (!cancelled) {
          setResourceFileUrls({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAccessibleResources, item?.id, session?.access_token]);

  useEffect(() => {
    setActiveReferencePreview(null);
  }, [item?.id]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (activeReferencePreview) {
          setActiveReferencePreview(null);
          return;
        }

        handleClose();
        return;
      }

      if (activeReferencePreview) {
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
  }, [activeReferencePreview, goNext, goPrevious, handleClose, isOpen]);

  // Auto-fetch free bundles so reference previews are visible immediately.
  // Free published bundles return viewerCanAccess: true via GET (no POST unlock needed).
  useEffect(() => {
    if (!isOpen || !item?.id || !item?.asset) {
      return;
    }

    const isPublicRecipe = Boolean(item.asset.id && isGenerationRecipeAssetId(item.asset.id));
    const isFree = item.asset.accessMode === 'free' || item.asset.priceUsdCents === 0;
    const alreadyUnlocked = unlockSuccessItemId === item.id;

    if (isPublicRecipe || !isFree || alreadyUnlocked) {
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
          setUnlockedResources(bundle.resources);
          setShowUnlockedDetails(false);
          setUnlockError(null);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }

        setUnlockError(err instanceof Error ? err.message : 'Failed to load free unlock.');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.id, item?.asset?.id, item?.asset?.accessMode, item?.asset?.priceUsdCents, unlockSuccessItemId, fetchBundleForItem]);

  if (!isOpen || !item) {
    return null;
  }

  const resourceKinds = getItemResourceKinds(item);
  const isSaved = savedItemIds.has(item.id);
  const isSaving = savingItemIds.has(item.id);
  const summary = getItemSummary(item);
  const dateLabel = formatDate(item.createdAt);
  const mediaTypeLabel = getMediaTypeLabel(item);
  const unlockCtaLabel = item.asset ? getAssetPurchaseCtaLabel(item.asset) : null;
  const isUnlockCheckoutOpen = Boolean(item.asset && activeUnlockCheckoutItemId === item.id);
  const hasReelUnlockAccess = unlockSuccessItemId === item.id;
  const isFreeUnlock = Boolean(item.asset && (item.asset.accessMode === 'free' || item.asset.priceUsdCents === 0));
  const priceLabel = item.asset
    ? item.asset.priceQuote?.formatted ?? getAssetAccessLabel(item.asset).replace(/\s+unlock$/i, '')
    : '';
  const tokenCost = item.asset ? Math.max(0, item.asset.priceUsdCents) : 0;
  const hasKnownInsufficientTokens = Boolean(session?.access_token && typeof credits === 'number' && credits < tokenCost);
  const includedKindLabels = resourceKinds.map(getPostResourceKindLabel);
  const bundleCountSummary = item.asset
    ? formatPostResourceBundleCountSummary(item.asset.lockedPreview ?? null)
    : '';
  const publicRecipeIsLoading = publicRecipeLoadingItemId === item.id;
  const shouldWaitForMedia = item.postFormat !== 'text' && Boolean(activeMediaItem);
  const currentMediaKey = activeMediaItem ? `${item.id}:${activeMediaItem.id}` : null;
  const isMediaReady = !currentMediaKey || loadedMediaKeys.has(currentMediaKey);
  const showMediaLoading = shouldWaitForMedia && !isMediaReady;
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

  const finishReelUnlock = async () => {
    const bundle = await fetchBundleForItem(item.id);
    setUnlockSuccessItemId(item.id);
    setUnlockedResources(bundle.resources);
    setShowUnlockedDetails(false);
    setUnlockError(null);
  };

  const openFreeUnlock = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    try {
      setUnlockWorkingAction('free');
      setUnlockError(null);
      const response = await fetch(`/api/posts/${item.id}/resource-bundle/unlock-free`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to open the free unlock.');
      }

      await finishReelUnlock();
    } catch (unlockError) {
      setUnlockError(unlockError instanceof Error ? unlockError.message : 'Failed to open the free unlock.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  const startCashCheckout = async () => {
    if (!item.asset || !ensureAuthenticated()) {
      return;
    }

    try {
      setUnlockWorkingAction('cash');
      setUnlockError(null);
      const orderResponse = await fetch(`/api/posts/${item.id}/resource-bundle/order`, {
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
        name: 'magicbooklet unlock',
        description: orderData.bundleTitle || item.asset.title,
        order_id: orderData.orderId,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          try {
            setUnlockWorkingAction('cash');
            const verifyResponse = await fetch(`/api/posts/${item.id}/resource-bundle/verify`, {
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

            await finishReelUnlock();
          } catch (verifyError) {
            setUnlockError(verifyError instanceof Error ? verifyError.message : 'Payment verification failed.');
          } finally {
            setUnlockWorkingAction(null);
          }
        },
        theme: {
          color: '#34d399',
        },
      });

      razorpay.on('payment.failed', (payload: unknown) => {
        const errorPayload = payload as { error?: { description?: string } } | null;
        setUnlockError(errorPayload?.error?.description || 'Payment failed. Please try again.');
      });

      razorpay.open();
    } catch (checkoutError) {
      setUnlockError(checkoutError instanceof Error ? checkoutError.message : 'Failed to start checkout.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  const unlockWithTokens = async () => {
    if (!ensureAuthenticated()) {
      return;
    }

    if (hasKnownInsufficientTokens) {
      setUnlockError(`This unlock needs ${tokenCost.toLocaleString()} tokens.`);
      return;
    }

    try {
      setUnlockWorkingAction('tokens');
      setUnlockError(null);
      const response = await fetch(`/api/posts/${item.id}/resource-bundle/unlock-with-credits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
      const data = await response.json();

      if (!response.ok || !data?.success) {
        throw new Error(data.error || 'Failed to unlock with tokens.');
      }

      if (typeof data.credits === 'number') {
        updateCredits(data.credits);
      }

      await finishReelUnlock();
    } catch (unlockError) {
      setUnlockError(unlockError instanceof Error ? unlockError.message : 'Failed to unlock with tokens.');
    } finally {
      setUnlockWorkingAction(null);
    }
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
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

    const target = event.target instanceof HTMLElement ? event.target : null;
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

  const renderRecipeResourcesCard = (
    resources: ReelBundleResources,
    options?: { title?: string; compact?: boolean }
  ) => {
    const resourceItems = resources.items ?? [];
    const promptText = resources.promptText
      || resourceItems.find((resourceItem) => resourceItem.type === 'prompt' && resourceItem.textContent)?.textContent
      || null;
    const notesMarkdown = resources.notesMarkdown
      || resourceItems.find((resourceItem) => resourceItem.type === 'note' && resourceItem.textContent)?.textContent
      || null;
    const referenceItems = resourceItems.filter((resourceItem) =>
      resourceItem.storagePath
      || resourceItem.externalUrl
      || resourceItem.type === 'reference_image'
      || resourceItem.type === 'source_file'
    );
    const attachmentItems = resources.attachments.filter((attachment) => attachment.url || attachment.storagePath);
    const hasRecipeContent = Boolean(
      promptText
      || notesMarkdown
      || referenceItems.length > 0
      || attachmentItems.length > 0
      || resources.allowRemix
    );

    if (!hasRecipeContent) {
      return null;
    }

    return (
      <div className={`${options?.compact ? 'mt-3' : 'mt-5'} rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
              {options?.title ?? 'Creation recipe'}
            </div>
            <p className="mt-1 text-sm leading-6 text-emerald-50/75">
              Prompt, references, notes, and remix access available here.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-medium text-emerald-50">
            Ready
          </span>
        </div>

        {promptText ? (
          <div className="mt-4 rounded-2xl border border-white/8 bg-black/35 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Prompt</div>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(promptText)}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.08]"
              >
                Copy
              </button>
            </div>
            <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-200 [overflow-wrap:anywhere] app-scrollbar">
              {promptText}
            </p>
          </div>
        ) : null}

        {referenceItems.length > 0 || attachmentItems.length > 0 ? (
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">References</div>
            <div className="mt-3 flex flex-wrap gap-3">
              {referenceItems.map((resourceItem, index) => {
                const hasFile = Boolean(resourceItem.storagePath || resourceItem.externalUrl);
                const fileUrl = hasFile
                  ? (resourceItem.storagePath ? resourceFileUrls[resourceItem.storagePath] : resourceItem.externalUrl)
                  : null;
                const isImage = resourceItem.type === 'reference_image' || resourceItem.contentType?.startsWith('image/');
                const isVideo = resourceItem.contentType?.startsWith('video/');
                const isAudio = resourceItem.contentType?.startsWith('audio/');
                const showMediaPreview = hasFile && (isImage || isVideo || isAudio);

                return (
                  isImage && fileUrl ? (
                    <button
                      key={`${resourceItem.storagePath ?? resourceItem.externalUrl ?? resourceItem.title}:${index}`}
                      type="button"
                      onClick={() => setActiveReferencePreview({
                        src: fileUrl,
                        alt: resourceItem.title,
                      })}
                      aria-label={`Open preview for ${resourceItem.title}`}
                      className="group w-[112px] shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/35 text-left transition hover:border-white/20"
                    >
                      <div className="flex h-full flex-col">
                        <div className="flex aspect-[3/4] items-center justify-center bg-black">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={fileUrl}
                            alt={resourceItem.title}
                            className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]"
                          />
                        </div>
                        <div className="border-t border-white/8 bg-black/45 px-3 py-2">
                          <div className="truncate text-xs font-medium text-zinc-100">
                            {resourceItem.title}
                          </div>
                        </div>
                      </div>
                    </button>
                  ) : (
                    <div
                      key={`${resourceItem.storagePath ?? resourceItem.externalUrl ?? resourceItem.title}:${index}`}
                      className="min-w-0 basis-[180px] overflow-hidden rounded-2xl border border-white/10 bg-black/35 p-3"
                    >
                      {showMediaPreview && fileUrl && isVideo ? (
                        <video src={fileUrl} controls className="h-full w-full object-contain" />
                      ) : showMediaPreview && fileUrl && isAudio ? (
                        <audio src={fileUrl} controls className="w-full" />
                      ) : (
                        <div className="text-xs text-zinc-400">{resourceItem.title}</div>
                      )}
                    </div>
                  )
                );
              })}

              {attachmentItems.map((attachment, index) => {
                const fileUrl = attachment.storagePath ? resourceFileUrls[attachment.storagePath] : attachment.url;

                return (
                  <div
                    key={`${attachment.storagePath ?? attachment.url ?? attachment.label}:${index}`}
                    className="min-w-0 basis-[180px] rounded-2xl border border-white/10 bg-black/35 p-3"
                  >
                    <div className="truncate text-xs font-semibold text-zinc-100">{attachment.label}</div>
                    {fileUrl ? (
                      <a
                        href={fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex text-xs font-medium text-emerald-200 hover:text-emerald-100"
                      >
                        Open
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {notesMarkdown ? (
          <div className="mt-4 rounded-2xl border border-white/8 bg-black/35 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Notes</div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-200 [overflow-wrap:anywhere]">
              {notesMarkdown}
            </p>
          </div>
        ) : null}

        {resources.allowRemix ? (
          <div className="mt-4 rounded-2xl border border-purple-300/20 bg-purple-500/10 px-3 py-2 text-sm font-medium text-purple-100">
            Remix access is included.
          </div>
        ) : null}
      </div>
    );
  };

  const renderCompactUnlockCard = () => {
    if (!item.asset) {
      return null;
    }

    return (
      <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Unlock</div>
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

        {hasReelUnlockAccess ? (
          <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-black/25 p-4">
            <div className="text-sm font-semibold text-emerald-100">Unlocked</div>
            <p className="mt-1 text-sm leading-6 text-emerald-50/75">
              Your unlock is ready here.
            </p>
            <button
              type="button"
              onClick={() => setShowUnlockedDetails((currentValue) => !currentValue)}
              className="mt-3 inline-flex w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
              aria-expanded={showUnlockedDetails}
            >
              View unlocked details
            </button>
            {showUnlockedDetails ? (
              unlockedResources ? renderRecipeResourcesCard(unlockedResources, {
                title: 'Unlocked details',
                compact: true,
              }) : null
            ) : null}
          </div>
        ) : isFreeUnlock ? (
          <button
            type="button"
            onClick={() => void openFreeUnlock()}
            disabled={unlockWorkingAction !== null}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {unlockWorkingAction === 'free' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
            Open free unlock
          </button>
        ) : (
          <div className="mt-4 grid gap-2">
            <button
              type="button"
              onClick={() => void startCashCheckout()}
              disabled={unlockWorkingAction !== null}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {unlockWorkingAction === 'cash' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
              Pay with cash
            </button>
            <button
              type="button"
              onClick={() => void unlockWithTokens()}
              disabled={unlockWorkingAction !== null}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/25 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {unlockWorkingAction === 'tokens' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Pay with tokens
            </button>
          </div>
        )}

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
            unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
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
          initialIndex={activeMediaIndex}
          className="h-full"
          onIndexChange={(index) => {
            setActiveMediaIndex(index);
            onMediaIndexChange?.(index);
          }}
          onMediaReady={(index) => {
            const readyItem = mediaItems[index];
            if (readyItem) {
              markMediaReady(`${item.id}:${readyItem.id}`);
            }
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
      role="dialog"
      aria-modal="true"
      aria-label="Showcase reel viewer"
      className="fixed inset-0 z-[90] overflow-hidden bg-[#050506] text-white"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {item.asset && isUnlockCheckoutOpen && !isFreeUnlock ? (
        <Script id="showcase-reel-razorpay-checkout" src="https://checkout.razorpay.com/v1/checkout.js" />
      ) : null}

      <AnimatePresence>
        {activeReferencePreview ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.12 : 0.18 }}
            className="absolute inset-0 z-[120] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
            onClick={() => setActiveReferencePreview(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Reference image preview"
          >
            <div
              className="relative flex max-h-full w-full max-w-5xl items-center justify-center"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setActiveReferencePreview(null)}
                className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/65 text-zinc-300 transition hover:bg-zinc-900 hover:text-white"
                aria-label="Close reference preview"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex min-h-[220px] w-full items-center justify-center rounded-[24px] border border-white/10 bg-black p-4 sm:min-h-[420px] sm:p-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeReferencePreview.src}
                  alt={activeReferencePreview.alt}
                  className="max-h-[calc(100dvh-7rem)] max-w-full object-contain"
                />
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[14%] top-[-18%] h-[30rem] w-[30rem] rounded-full bg-purple-600/10 blur-[130px]" />
        <div className="absolute bottom-[-18%] right-[10%] h-[30rem] w-[30rem] rounded-full bg-emerald-500/10 blur-[130px]" />
      </div>

      <header className="relative z-10 flex h-14 items-center justify-between gap-3 border-b border-white/8 bg-black/40 px-3 backdrop-blur-xl sm:px-5">
        <button
          type="button"
          onClick={handleClose}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
          Feed
        </button>

        <div className="min-w-0 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">Community reel</div>
          <div className="text-xs text-zinc-300">
            {selectedIndex + 1} / {items.length}
          </div>
        </div>

        <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1">Arrow keys</span>
        </div>
      </header>

      <div className="relative z-10 grid h-[calc(100dvh-3.5rem)] min-h-0 grid-rows-[minmax(0,1fr)_auto_minmax(180px,0.45fr)] gap-3 px-3 pb-3 pt-3 lg:grid-cols-[minmax(0,1fr)_78px_390px] lg:grid-rows-none lg:px-5">
        <section className="relative min-h-0 overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_26px_90px_rgba(0,0,0,0.5)]">
          <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-semibold text-zinc-100 backdrop-blur-md">
              {mediaTypeLabel}
            </span>
            <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur-md">
              {dateLabel}
            </span>
          </div>

          <div className="relative h-full w-full overflow-hidden">
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
                  aria-hidden="true"
                >
                  <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent,rgba(255,255,255,0.08),transparent)] [animation:skeleton-shimmer_1.35s_ease-in-out_infinite]" />
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

          <div className="absolute right-3 top-1/2 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
            <button
              type="button"
              onClick={goPrevious}
              disabled={!previousItem}
              aria-label="Previous post"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/50 text-zinc-100 backdrop-blur-md transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!nextItem && !hasMoreItems}
              aria-busy={!nextItem && hasMoreItems && isLoadingMoreItems}
              aria-label="Next post"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/50 text-zinc-100 backdrop-blur-md transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {!nextItem && hasMoreItems && isLoadingMoreItems ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
            </button>
          </div>
        </section>

        <aside className="flex items-center justify-center gap-2 rounded-[24px] border border-white/10 bg-white/[0.035] p-2 backdrop-blur-xl lg:flex-col lg:border-0 lg:bg-transparent lg:p-0">
          <button
            type="button"
            onClick={() => void onToggleSave(item.id)}
            disabled={isSaving}
            aria-pressed={isSaved}
            aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${item.title}`}
            className={`inline-flex h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border text-xs font-semibold transition lg:h-[70px] lg:w-[70px] lg:flex-none ${
              isSaved
                ? 'border-pink-400/30 bg-pink-500/15 text-pink-100'
                : 'border-white/10 bg-white/[0.05] text-zinc-100 hover:bg-white/[0.08]'
            } disabled:opacity-60`}
          >
            <Heart className={`h-5 w-5 ${isSaved ? 'fill-pink-400 text-pink-300' : ''}`} />
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

          <PublicShareButton
            generationId={item.id}
            title={item.title}
            description={item.body || item.prompt}
            sourceSurface="showcase"
            accessToken={accessToken ?? null}
            label="Share"
            className="inline-flex h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.08] lg:h-[70px] lg:w-[70px] lg:flex-none"
          />

          {item.asset && !isPublicRecipeAsset ? (
            <button
              type="button"
              onClick={openUnlockCheckout}
              aria-label={unlockCtaLabel ?? 'Open unlock'}
              className="inline-flex h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/25 bg-emerald-500/12 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300/45 hover:bg-emerald-500/18 lg:h-[70px] lg:w-[70px] lg:flex-none"
            >
              <ShoppingBag className="h-5 w-5" />
              <span>{unlockCtaLabel}</span>
            </button>
          ) : null}

          {item.canRemix ? (
            <button
              type="button"
              onClick={() => void onRemix(item.id)}
              className="inline-flex h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border border-purple-300/25 bg-purple-500/15 text-xs font-semibold text-purple-100 transition hover:border-purple-300/45 hover:bg-purple-500/20 lg:h-[70px] lg:w-[70px] lg:flex-none"
            >
              <Wand2 className="h-5 w-5" />
              <span>Remix</span>
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
                <CreatorIdentity creator={item.creator} prefetch={false} />

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

                <p className="mt-5 text-sm leading-7 text-zinc-300">
                  {summary}
                </p>

                {isPublicRecipeAsset ? (
                  publicRecipeIsLoading ? (
                    <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-100">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading recipe
                      </div>
                    </div>
                  ) : publicRecipeError ? (
                    <div className="mt-5 rounded-[22px] border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-100">
                      {publicRecipeError}
                    </div>
                  ) : activeAccessibleResources ? (
                    renderRecipeResourcesCard(activeAccessibleResources)
                  ) : null
                ) : null}

                {item.asset && !isUnlockCheckoutOpen && !isPublicRecipeAsset && !hasReelUnlockAccess ? (
                  <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-500/10 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Unlock</div>
                        <h3 className="mt-2 text-base font-semibold text-white">{item.asset.title}</h3>
                      </div>
                      <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-300 px-2.5 py-1 text-xs font-bold text-slate-950">
                        {getAssetAccessLabel(item.asset)}
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
                      onClick={openUnlockCheckout}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
                    >
                      <LockKeyhole className="h-4 w-4" />
                      {unlockCtaLabel}
                    </button>
                  </div>
                ) : null}

                {item.asset && isUnlockCheckoutOpen && !isPublicRecipeAsset ? (
                  renderCompactUnlockCard()
                ) : null}

                {item.asset && hasReelUnlockAccess && !isUnlockCheckoutOpen && !isPublicRecipeAsset && unlockedResources ? (
                  renderRecipeResourcesCard(unlockedResources, {
                    title: 'Unlocked details',
                  })
                ) : null}

                {item.body.trim() ? (
                  <div className="mt-5 rounded-[20px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Note</div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300">
                      {item.body}
                    </p>
                  </div>
                ) : null}

                {item.prompt.trim() && !isPublicRecipeAsset ? (
                  <div className="mt-5 rounded-[20px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                      {item.postFormat === 'text' ? 'Workflow notes' : 'Prompt'}
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
                    Open full page
                  </Link>
                  <Link
                    href="/create"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                  >
                    <Sparkles className="h-4 w-4" />
                    Create your own
                  </Link>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </section>
      </div>
    </div>
  );
}
