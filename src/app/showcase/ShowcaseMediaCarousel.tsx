'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, ChevronLeft, ChevronRight, Images, Maximize2, Play, RotateCcw } from 'lucide-react';

import { OptimizedPreviewImage } from '@/app/components/OptimizedPreviewImage';
import { useMediaLoadingPreferences } from '@/app/components/useMediaLoadingPreferences';
import { buildOptimizedPreviewImageUrl } from '@/lib/preview-images';
import type { ShowcaseMediaItem } from '@/lib/showcase';

interface ShowcaseMediaCarouselProps {
  mediaItems: ShowcaseMediaItem[];
  title: string;
  initialIndex?: number;
  mode?: 'feed' | 'detail' | 'reel';
  /** Overrides the mode's default frame ratio, e.g. a single-column feed that
   *  wants the cover's real shape instead of the grid's 4:5 tile. Pass 'auto'
   *  when the server did not record dimensions and the cover should be measured
   *  on load instead. */
  aspectRatio?: number | string | null;
  /** Overrides the mode's default object-fit for the same reason. */
  fit?: 'cover' | 'contain';
  /** Overrides the responsive `sizes` hint when the frame is not a grid cell. */
  sizes?: string;
  className?: string;
  viewportClassName?: string;
  allowFullscreen?: boolean;
  autoPlayVideo?: boolean;
  priority?: boolean;
  priorityPoster?: {
    mediaId: string;
    dataUrl: string;
  } | null;
  onOpen?: (index: number) => void;
  onIndexChange?: (index: number) => void;
  onMediaReady?: (item: ShowcaseMediaItem) => void;
  onMediaError?: (item: ShowcaseMediaItem) => void;
  onMediaRetry?: (item: ShowcaseMediaItem) => void;
}

const MEDIA_LOAD_TIMEOUT_MS = 15_000;
const HAVE_METADATA = 1;

function clampIndex(index: number, itemCount: number) {
  return Math.min(Math.max(index, 0), Math.max(0, itemCount - 1));
}

export default function ShowcaseMediaCarousel({
  mediaItems,
  title,
  initialIndex = 0,
  mode = 'feed',
  aspectRatio = null,
  fit,
  sizes,
  className = '',
  viewportClassName = '',
  allowFullscreen = false,
  autoPlayVideo,
  priority = false,
  priorityPoster = null,
  onOpen,
  onIndexChange,
  onMediaReady,
  onMediaError,
  onMediaRetry,
}: ShowcaseMediaCarouselProps) {
  const items = useMemo(
    () => mediaItems.slice().sort((left, right) => left.sortOrder - right.sortOrder),
    [mediaItems]
  );
  const [activeIndex, setActiveIndex] = useState(() => clampIndex(initialIndex, items.length));
  const [coverAspectRatio, setCoverAspectRatio] = useState<number | null>(() => {
    const cover = items[0];
    return cover?.width && cover?.height ? cover.width / cover.height : null;
  });
  const [isInViewport, setIsInViewport] = useState(mode !== 'feed');
  const [isNearViewport, setIsNearViewport] = useState(mode !== 'feed');
  const [isInteracting, setIsInteracting] = useState(false);
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const lifecycleStatusRef = useRef<Map<string, 'ready' | 'error'>>(new Map());
  const [failedLoadKeys, setFailedLoadKeys] = useState<Set<string>>(new Set());
  const [loadAttempts, setLoadAttempts] = useState<Record<string, number>>({});
  const { prefersReducedMotion, saveData } = useMediaLoadingPreferences();
  const requestedAutoPlay = autoPlayVideo ?? mode !== 'feed';
  const canPlayMotion = !prefersReducedMotion && !saveData;
  const shouldPlayVideo = canPlayMotion && (
    mode === 'feed'
      ? isInteracting || (requestedAutoPlay && isInViewport)
      : requestedAutoPlay
  );
  const shouldAttachVideo = mode !== 'feed' || (
    canPlayMotion
    && (isInteracting || (requestedAutoPlay && isInViewport))
  );
  const activeItem = items[activeIndex] ?? items[0] ?? null;
  const activeSourceKey = activeItem ? JSON.stringify([activeItem.id, activeItem.url]) : '';
  const activeLoadAttempt = activeSourceKey ? loadAttempts[activeSourceKey] ?? 0 : 0;
  const activeLoadKey = activeItem
    ? JSON.stringify([activeItem.id, activeItem.url, activeLoadAttempt])
    : '';
  const hasActiveMediaError = Boolean(activeLoadKey && failedLoadKeys.has(activeLoadKey));
  const shouldActuallyPlayVideo = shouldPlayVideo && !hasActiveMediaError;

  const reportMediaReady = useCallback((mediaItem: ShowcaseMediaItem, loadKey: string) => {
    // An error is terminal for this exact source attempt. Retry creates a new
    // load key, so late canplay/playing events from the failed element cannot
    // dismiss the recovery UI or restart audio behind it.
    if (lifecycleStatusRef.current.has(loadKey)) {
      return;
    }

    lifecycleStatusRef.current.set(loadKey, 'ready');
    setFailedLoadKeys((currentKeys) => {
      if (!currentKeys.has(loadKey)) {
        return currentKeys;
      }

      const nextKeys = new Set(currentKeys);
      nextKeys.delete(loadKey);
      return nextKeys;
    });
    onMediaReady?.(mediaItem);
  }, [onMediaReady]);

  const reportActiveVideoReady = useCallback((video: HTMLVideoElement) => {
    if (!activeItem || activeItem.mediaKind !== 'video' || !activeLoadKey) {
      return;
    }

    // Audio can be playable even when the browser cannot decode a visual track.
    // Keep the recovery path active until the element proves it has video frames.
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      return;
    }

    if (activeIndex === 0) {
      setCoverAspectRatio(video.videoWidth / video.videoHeight);
    }
    reportMediaReady(activeItem, activeLoadKey);
  }, [activeIndex, activeItem, activeLoadKey, reportMediaReady]);

  const reportActiveMediaError = useCallback(() => {
    if (!activeItem || !activeLoadKey || lifecycleStatusRef.current.get(activeLoadKey) === 'error') {
      return;
    }

    activeVideoRef.current?.pause();
    lifecycleStatusRef.current.set(activeLoadKey, 'error');
    setFailedLoadKeys((currentKeys) => {
      if (currentKeys.has(activeLoadKey)) {
        return currentKeys;
      }

      const nextKeys = new Set(currentKeys);
      nextKeys.add(activeLoadKey);
      return nextKeys;
    });
    onMediaError?.(activeItem);
  }, [activeItem, activeLoadKey, onMediaError]);

  const retryActiveMedia = useCallback(() => {
    if (!activeItem || !activeSourceKey || !activeLoadKey) {
      return;
    }

    lifecycleStatusRef.current.delete(activeLoadKey);
    setFailedLoadKeys((currentKeys) => {
      if (!currentKeys.has(activeLoadKey)) {
        return currentKeys;
      }

      const nextKeys = new Set(currentKeys);
      nextKeys.delete(activeLoadKey);
      return nextKeys;
    });
    setLoadAttempts((currentAttempts) => ({
      ...currentAttempts,
      [activeSourceKey]: (currentAttempts[activeSourceKey] ?? 0) + 1,
    }));
    onMediaRetry?.(activeItem);
  }, [activeItem, activeLoadKey, activeSourceKey, onMediaRetry]);

  useEffect(() => {
    const carousel = carouselRef.current;
    if (mode !== 'feed' || !carousel || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInViewport(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.45));
      },
      { threshold: [0, 0.45, 1] }
    );
    observer.observe(carousel);

    return () => {
      observer.disconnect();
    };
  }, [mode]);

  useEffect(() => {
    const carousel = carouselRef.current;
    if (mode !== 'feed' || !carousel || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: '320px 0px', threshold: 0 }
    );
    observer.observe(carousel);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    const video = activeVideoRef.current;
    if (!video) {
      return;
    }

    if (shouldActuallyPlayVideo) {
      const playResult = video.play();
      void playResult?.catch(() => {
        // Browsers can decline autoplay until the page has received interaction.
      });
    } else {
      video.pause();
    }

    return () => {
      video.pause();
    };
  }, [activeIndex, activeLoadKey, shouldActuallyPlayVideo, shouldAttachVideo]);

  useEffect(() => {
    if (!activeItem || activeItem.mediaKind !== 'video' || !shouldAttachVideo) {
      return;
    }

    const reconcileReadyState = () => {
      const video = activeVideoRef.current;
      if (
        video
        && video.readyState >= HAVE_METADATA
        && video.videoWidth > 0
        && video.videoHeight > 0
      ) {
        reportActiveVideoReady(video);
      }
    };

    // A cached video may already be ready before React observes loadedmetadata.
    // Reconcile after commit and once more on the next paint to close that race.
    reconcileReadyState();
    if (typeof window.requestAnimationFrame !== 'function') {
      return;
    }

    const frameId = window.requestAnimationFrame(reconcileReadyState);
    return () => window.cancelAnimationFrame(frameId);
  }, [activeItem, activeLoadKey, reportActiveVideoReady, shouldAttachVideo]);

  useEffect(() => {
    if (
      mode === 'feed'
      || !activeItem
      || activeItem.mediaKind !== 'video'
      || !shouldAttachVideo
      || hasActiveMediaError
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lifecycleStatusRef.current.get(activeLoadKey)) {
        return;
      }

      const video = activeVideoRef.current;
      if (
        video
        && video.readyState >= HAVE_METADATA
        && video.videoWidth > 0
        && video.videoHeight > 0
      ) {
        reportActiveVideoReady(video);
        return;
      }

      reportActiveMediaError();
    }, MEDIA_LOAD_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    activeItem,
    activeLoadKey,
    hasActiveMediaError,
    mode,
    reportActiveMediaError,
    reportActiveVideoReady,
    shouldAttachVideo,
  ]);

  const selectIndex = (nextIndex: number) => {
    const clamped = clampIndex(nextIndex, items.length);
    if (clamped === activeIndex) {
      return;
    }

    setActiveIndex(clamped);
    onIndexChange?.(clamped);
  };

  const openFullscreen = () => {
    const mediaViewport = carouselRef.current?.querySelector<HTMLElement>('[data-showcase-media-viewport]');

    if (!mediaViewport?.requestFullscreen) {
      window.open(activeItem?.url ?? '', '_blank', 'noopener,noreferrer');
      return;
    }

    void mediaViewport.requestFullscreen().catch(() => {
      window.open(activeItem?.url ?? '', '_blank', 'noopener,noreferrer');
    });
  };

  if (items.length === 0) {
    return null;
  }

  // The empty state above guarantees an active item for the render below.
  const renderedActiveItem = activeItem ?? items[0];
  const isDetail = mode === 'detail';
  const isReel = mode === 'reel';
  const showControls = isDetail || isReel;
  const frameAspectRatio = aspectRatio === 'auto'
    ? coverAspectRatio ?? '4 / 5'
    : aspectRatio ?? (mode === 'feed' ? '4 / 5' : coverAspectRatio ?? '16 / 10');
  const frameFit = fit ?? (mode === 'feed' ? 'cover' : 'contain');
  const previewUrl = renderedActiveItem.previewUrl ?? null;
  const posterUrl = priorityPoster?.mediaId === renderedActiveItem.id
    ? priorityPoster.dataUrl
    : previewUrl
      ? buildOptimizedPreviewImageUrl(previewUrl)
      : null;
  const shouldLoadPoster = mode !== 'feed'
    || priority
    || isNearViewport
    || isInViewport
    || isInteracting;

  return (
    <div ref={carouselRef} className={className}>
      <div
        data-showcase-media-viewport
        className={`group/carousel relative overflow-hidden bg-black ${isDetail ? 'rounded-[22px]' : ''} ${isReel ? 'h-full' : ''} ${onOpen ? 'cursor-pointer' : ''} ${viewportClassName}`}
        style={isReel ? undefined : { aspectRatio: frameAspectRatio }}
        onClick={(event) => {
          if (!onOpen || event.target instanceof HTMLElement && event.target.closest('button, video[controls]')) {
            return;
          }

          onOpen(activeIndex);
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const start = touchStartRef.current;
          const touch = event.changedTouches[0];
          touchStartRef.current = null;
          if (!start || !touch || items.length < 2) {
            return;
          }

          const deltaX = touch.clientX - start.x;
          const deltaY = touch.clientY - start.y;
          if (Math.abs(deltaX) < 42 || Math.abs(deltaX) <= Math.abs(deltaY)) {
            return;
          }

          selectIndex(activeIndex + (deltaX < 0 ? 1 : -1));
        }}
        onMouseEnter={() => {
          if (mode === 'feed') {
            setIsInteracting(true);
          }
        }}
        onMouseLeave={() => {
          if (mode === 'feed') {
            setIsInteracting(false);
          }
        }}
        onFocusCapture={() => {
          if (mode === 'feed') {
            setIsInteracting(true);
          }
        }}
        onBlurCapture={(event) => {
          if (mode === 'feed' && !event.currentTarget.contains(event.relatedTarget)) {
            setIsInteracting(false);
          }
        }}
      >
        <div className="absolute inset-0 z-[1] h-full w-full">
          {renderedActiveItem.mediaKind === 'video' ? (
            <>
              <video
                ref={activeVideoRef}
                key={activeLoadKey}
                src={shouldAttachVideo ? renderedActiveItem.url : undefined}
                poster={shouldLoadPoster ? posterUrl ?? undefined : undefined}
                muted={!showControls || hasActiveMediaError}
                controls={showControls && !hasActiveMediaError}
                autoPlay={shouldActuallyPlayVideo}
                loop
                playsInline
                aria-label={title}
                aria-hidden={hasActiveMediaError || undefined}
                tabIndex={hasActiveMediaError ? -1 : undefined}
                preload={mode === 'feed' ? 'none' : 'metadata'}
                onLoadedMetadata={(event) => {
                  reportActiveVideoReady(event.currentTarget);
                }}
                onLoadedData={(event) => reportActiveVideoReady(event.currentTarget)}
                onCanPlay={(event) => reportActiveVideoReady(event.currentTarget)}
                onPlaying={(event) => reportActiveVideoReady(event.currentTarget)}
                onError={reportActiveMediaError}
                className={`h-full w-full ${frameFit === 'cover' ? 'object-cover' : 'object-contain'}`}
              />
              {!showControls ? (
                <span className="pointer-events-none absolute bottom-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md">
                  <Play className="h-4 w-4 fill-current" />
                </span>
              ) : null}
            </>
          ) : mode === 'feed' ? (
            <OptimizedPreviewImage
              key={activeLoadKey}
              previewSrc={previewUrl ?? renderedActiveItem.url}
              fallbackSrc={renderedActiveItem.url}
              alt={title}
              sizes={sizes ?? '(min-width: 1280px) 25vw, (min-width: 768px) 33vw, (min-width: 640px) 50vw, 100vw'}
              priority={priority}
              onLoad={(event) => {
                // Only the cover defines the frame, and only when the server did
                // not already record dimensions.
                const image = event.currentTarget;
                if (activeIndex === 0 && image.naturalWidth && image.naturalHeight) {
                  setCoverAspectRatio(image.naturalWidth / image.naturalHeight);
                }
                reportMediaReady(renderedActiveItem, activeLoadKey);
              }}
              className={frameFit === 'cover' ? 'object-cover' : 'object-contain'}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={activeLoadKey}
              src={renderedActiveItem.url}
              alt={title}
              loading={isDetail ? 'eager' : 'lazy'}
              decoding="async"
              onLoad={(event) => {
                if (activeIndex === 0 && event.currentTarget.naturalWidth && event.currentTarget.naturalHeight) {
                  setCoverAspectRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight);
                }
                reportMediaReady(renderedActiveItem, activeLoadKey);
              }}
              onError={reportActiveMediaError}
              className="h-full w-full object-contain"
            />
          )}
        </div>

        {hasActiveMediaError ? (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-[6] flex items-center justify-center bg-black/90 px-6 text-center"
          >
            <div className="max-w-sm">
              <CircleAlert className="mx-auto h-7 w-7 text-amber-300" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-white">
                {renderedActiveItem.mediaKind === 'video' ? 'Video couldn\u2019t be loaded' : 'Image couldn\u2019t be loaded'}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">Check your connection, then try again.</p>
              <button
                type="button"
                onClick={retryActiveMedia}
                aria-label={renderedActiveItem.mediaKind === 'video' ? 'Retry video' : 'Retry image'}
                className="ui-focus-ring mx-auto mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(activeIndex)}
            className="absolute inset-0 z-[2] h-full w-full"
            aria-label={title}
          />
        ) : null}

        {items.length > 1 || allowFullscreen ? (
          <div className="absolute right-3 top-3 z-[5] flex items-center gap-2">
            {items.length > 1 ? (
              <div
                role="status"
                aria-live="polite"
                aria-label={`Media ${activeIndex + 1} of ${items.length}`}
                className="pointer-events-none inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md"
              >
                <Images className="h-3.5 w-3.5" />
                {activeIndex + 1}/{items.length}
              </div>
            ) : null}
            {allowFullscreen ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openFullscreen();
                }}
                aria-label="Open media full screen"
                className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition hover:bg-black/85"
              >
                <Maximize2 size={16} className="h-4 w-4 shrink-0" />
              </button>
            ) : null}
          </div>
        ) : null}

        {items.length > 1 ? (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                selectIndex(activeIndex - 1);
              }}
              disabled={activeIndex === 0}
              aria-label="Previous media"
              className="ui-focus-ring absolute left-3 top-1/2 z-[4] hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition hover:bg-black/85 disabled:opacity-25 group-hover/carousel:flex sm:flex"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                selectIndex(activeIndex + 1);
              }}
              disabled={activeIndex === items.length - 1}
              aria-label="Next media"
              className="ui-focus-ring absolute right-3 top-1/2 z-[4] hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition hover:bg-black/85 disabled:opacity-25 group-hover/carousel:flex sm:flex"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <div role="group" className="absolute inset-x-0 bottom-0 z-[4] flex justify-center gap-0.5" aria-label="Choose media">
              {items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectIndex(index);
                  }}
                  aria-label={`Show media ${index + 1}`}
                  aria-pressed={index === activeIndex}
                  className="ui-focus-ring group flex h-12 min-w-8 items-center justify-center rounded-full"
                >
                  <span
                    aria-hidden
                    className={`h-1.5 rounded-full transition ${
                      index === activeIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/45 group-hover:bg-white/70'
                    }`}
                  />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {isDetail && items.length > 1 ? (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Media thumbnails">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectIndex(index)}
              aria-label={`Show media ${index + 1}`}
              className={`relative h-20 w-16 shrink-0 overflow-hidden rounded-md border bg-black ${
                index === activeIndex ? 'border-emerald-300/70' : 'border-white/10'
              }`}
            >
              {item.mediaKind === 'video' ? (
                item.previewUrl ? (
                  <OptimizedPreviewImage
                    previewSrc={item.previewUrl}
                    alt=""
                    sizes="64px"
                    className="object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-white/70">
                    <Play className="h-5 w-5 fill-current" />
                  </span>
                )
              ) : (
                <OptimizedPreviewImage
                  previewSrc={item.previewUrl ?? item.url}
                  fallbackSrc={item.url}
                  alt=""
                  sizes="64px"
                  className="object-cover"
                />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
