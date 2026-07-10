'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Images, Play } from 'lucide-react';

import type { ShowcaseMediaItem } from '@/lib/showcase';

interface ShowcaseMediaCarouselProps {
  mediaItems: ShowcaseMediaItem[];
  title: string;
  initialIndex?: number;
  mode?: 'feed' | 'detail' | 'reel';
  className?: string;
  autoPlayVideo?: boolean;
  onOpen?: (index: number) => void;
  onIndexChange?: (index: number) => void;
  onMediaReady?: (index: number) => void;
}

function clampIndex(index: number, itemCount: number) {
  return Math.min(Math.max(index, 0), Math.max(0, itemCount - 1));
}

export default function ShowcaseMediaCarousel({
  mediaItems,
  title,
  initialIndex = 0,
  mode = 'feed',
  className = '',
  autoPlayVideo = true,
  onOpen,
  onIndexChange,
  onMediaReady,
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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [failedPreviewIds, setFailedPreviewIds] = useState<Set<string>>(() => new Set());
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const shouldAutoPlayVideo = autoPlayVideo && !prefersReducedMotion && (mode !== 'feed' || isInViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);
    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

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
    const video = activeVideoRef.current;
    if (!video) {
      return;
    }

    if (shouldAutoPlayVideo) {
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
  }, [activeIndex, shouldAutoPlayVideo]);

  const selectIndex = (nextIndex: number) => {
    const clamped = clampIndex(nextIndex, items.length);
    if (clamped === activeIndex) {
      return;
    }

    setActiveIndex(clamped);
    onIndexChange?.(clamped);
  };

  if (items.length === 0) {
    return null;
  }

  const activeItem = items[activeIndex] ?? items[0];
  const isDetail = mode === 'detail';
  const isReel = mode === 'reel';
  const showControls = isDetail || isReel;
  const feedPreviewUrl = mode === 'feed' && activeItem.previewUrl && !failedPreviewIds.has(activeItem.id)
    ? activeItem.previewUrl
    : null;

  return (
    <div ref={carouselRef} className={className}>
      <div
        className={`group/carousel relative overflow-hidden bg-black ${isDetail ? 'rounded-[22px]' : ''} ${isReel ? 'h-full' : ''} ${onOpen ? 'cursor-pointer' : ''}`}
        style={isReel ? undefined : { aspectRatio: mode === 'feed' ? '4 / 5' : coverAspectRatio ?? '16 / 10' }}
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
      >
        <div className="absolute inset-0 z-[1] h-full w-full">
          {activeItem.mediaKind === 'video' ? (
            <>
              <video
                ref={activeVideoRef}
                key={activeItem.id}
                src={activeItem.url}
                poster={feedPreviewUrl ?? undefined}
                muted={!showControls}
                controls={showControls}
                autoPlay={shouldAutoPlayVideo}
                loop
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  if (activeIndex === 0 && event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
                    setCoverAspectRatio(event.currentTarget.videoWidth / event.currentTarget.videoHeight);
                  }
                  onMediaReady?.(activeIndex);
                }}
                className={`h-full w-full ${mode === 'feed' ? 'object-cover' : 'object-contain'}`}
              />
              {!showControls ? (
                <span className="pointer-events-none absolute bottom-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md">
                  <Play className="h-4 w-4 fill-current" />
                </span>
              ) : null}
            </>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={activeItem.id}
              src={feedPreviewUrl ?? activeItem.url}
              alt={title}
              loading={isDetail ? 'eager' : 'lazy'}
              decoding="async"
              onLoad={(event) => {
                if (mode !== 'feed' && activeIndex === 0 && event.currentTarget.naturalWidth && event.currentTarget.naturalHeight) {
                  setCoverAspectRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight);
                }
                onMediaReady?.(activeIndex);
              }}
              onError={() => {
                if (feedPreviewUrl) {
                  setFailedPreviewIds((current) => new Set(current).add(activeItem.id));
                }
              }}
              className={`h-full w-full ${mode === 'feed' ? 'object-cover' : 'object-contain'}`}
            />
          )}
        </div>

        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(activeIndex)}
            className="absolute inset-0 z-[2] h-full w-full"
            aria-label={title}
          />
        ) : null}

        {items.length > 1 ? (
          <>
            <div className="pointer-events-none absolute right-3 top-3 z-[3] inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
              <Images className="h-3.5 w-3.5" />
              {activeIndex + 1}/{items.length}
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                selectIndex(activeIndex - 1);
              }}
              disabled={activeIndex === 0}
              aria-label="Previous media"
              className="absolute left-3 top-1/2 z-[4] hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition hover:bg-black/85 disabled:opacity-25 group-hover/carousel:flex sm:flex"
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
              className="absolute right-3 top-1/2 z-[4] hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition hover:bg-black/85 disabled:opacity-25 group-hover/carousel:flex sm:flex"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <div className="absolute inset-x-0 bottom-3 z-[4] flex justify-center gap-1.5">
              {items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectIndex(index);
                  }}
                  aria-label={`Show media ${index + 1}`}
                  className={`h-1.5 rounded-full transition ${
                    index === activeIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/45 hover:bg-white/70'
                  }`}
                />
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
                <video src={item.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.url} alt="" className="h-full w-full object-cover" />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
