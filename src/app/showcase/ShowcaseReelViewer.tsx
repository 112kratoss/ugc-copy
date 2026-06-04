'use client';

import Link from 'next/link';
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
import {
  getBundleAccessLabel,
  getPostResourceKindLabel,
  isPostResourceKind,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import type { ShowcaseFeedItem } from '@/lib/showcase';

interface ShowcaseReelViewerProps {
  isOpen: boolean;
  items: ShowcaseFeedItem[];
  selectedItemId: string | null;
  savedItemIds: Set<string>;
  savingItemIds: Set<string>;
  accessToken?: string | null;
  hasMoreItems: boolean;
  isLoadingMoreItems: boolean;
  onLoadMoreItems: () => void | Promise<void>;
  onClose: () => void;
  onSelectItemId: (id: string) => void;
  onToggleSave: (id: string) => void | Promise<void>;
  onRemix: (id: string) => void | Promise<void>;
  buildDetailPath: (id: string, section?: string) => string;
}

type ReelTransitionDirection = 'next' | 'previous' | 'neutral';

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
  if (asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: asset.accessMode,
      priceQuote: asset.priceQuote,
    });
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
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
    return kinds.length > 0
      ? `Unlock includes ${kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase()).join(', ')}.`
      : 'Reusable unlock attached.';
  }

  return `${item.category === 'text' ? 'Tip' : item.category} by ${item.creator.name}`;
}

function getMediaTypeLabel(item: ShowcaseFeedItem): string {
  if (item.postFormat === 'text' || item.category === 'text') {
    return 'Tip / note';
  }

  if (item.mediaKind === 'video') {
    return 'Video';
  }

  return 'Image';
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
  onLoadMoreItems,
  onClose,
  onSelectItemId,
  onToggleSave,
  onRemix,
  buildDetailPath,
}: ShowcaseReelViewerProps) {
  const touchStartYRef = useRef<number | null>(null);
  const wheelCooldownRef = useRef(0);
  const detailsScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingAdvanceAfterLoadRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const [transitionDirection, setTransitionDirection] = useState<ReelTransitionDirection>('neutral');
  const [loadedMediaKeys, setLoadedMediaKeys] = useState<Set<string>>(new Set());
  const selectedIndex = useMemo(
    () => selectedItemId ? items.findIndex((item) => item.id === selectedItemId) : -1,
    [items, selectedItemId]
  );
  const item = selectedIndex >= 0 ? items[selectedIndex] : null;
  const previousItem = selectedIndex > 0 ? items[selectedIndex - 1] : null;
  const nextItem = selectedIndex >= 0 && selectedIndex < items.length - 1 ? items[selectedIndex + 1] : null;

  const moveToItem = useCallback((targetItem: ShowcaseFeedItem, direction: ReelTransitionDirection) => {
    setTransitionDirection(direction);
    onSelectItemId(targetItem.id);
  }, [onSelectItemId]);

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
    setTransitionDirection('neutral');
    onClose();
  }, [onClose]);

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
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
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

  if (!isOpen || !item) {
    return null;
  }

  const resourceKinds = getItemResourceKinds(item);
  const isSaved = savedItemIds.has(item.id);
  const isSaving = savingItemIds.has(item.id);
  const summary = getItemSummary(item);
  const dateLabel = formatDate(item.createdAt);
  const mediaTypeLabel = getMediaTypeLabel(item);
  const shouldWaitForMedia = item.postFormat !== 'text' && Boolean(item.mediaUrl);
  const currentMediaKey = shouldWaitForMedia ? `${item.id}:${item.mediaUrl}` : null;
  const isMediaReady = !currentMediaKey || loadedMediaKeys.has(currentMediaKey);
  const showMediaLoading = shouldWaitForMedia && !isMediaReady;
  const transition = prefersReducedMotion
    ? { duration: 0.16, ease: 'easeOut' as const }
    : { duration: 0.34, ease: [0.22, 1, 0.36, 1] as const };
  const detailsTransition = prefersReducedMotion
    ? { duration: 0.16, ease: 'easeOut' as const }
    : { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const, delay: 0.04 };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    touchStartYRef.current = null;

    if (startY === null) {
      return;
    }

    const endY = event.changedTouches[0]?.clientY ?? startY;
    const deltaY = endY - startY;

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

    if (item.mediaKind === 'video' && item.mediaUrl) {
      const mediaKey = `${item.id}:${item.mediaUrl}`;

      return (
        <video
          key={item.id}
          src={item.mediaUrl}
          controls
          autoPlay
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => markMediaReady(mediaKey)}
          className="h-full w-full object-contain"
        />
      );
    }

    if (item.mediaUrl) {
      const mediaKey = `${item.id}:${item.mediaUrl}`;

      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={item.id}
          src={item.mediaUrl}
          alt={item.title}
          onLoad={() => markMediaReady(mediaKey)}
          className="h-full w-full object-contain"
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

          {item.asset ? (
            <Link
              href={buildDetailPath(item.id, 'resources')}
              prefetch={false}
              className="inline-flex h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border border-emerald-300/25 bg-emerald-500/12 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300/45 hover:bg-emerald-500/18 lg:h-[70px] lg:w-[70px] lg:flex-none"
            >
              <ShoppingBag className="h-5 w-5" />
              <span>Unlock</span>
            </Link>
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

                {item.asset ? (
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
                    <Link
                      href={buildDetailPath(item.id, 'resources')}
                      prefetch={false}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
                    >
                      <LockKeyhole className="h-4 w-4" />
                      View unlock details
                    </Link>
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
