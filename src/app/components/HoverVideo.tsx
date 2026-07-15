"use client";

import { useEffect, useRef, useState } from 'react';

import { useMediaLoadingPreferences } from '@/app/components/useMediaLoadingPreferences';
import { buildOptimizedPreviewImageUrl } from '@/lib/preview-images';

function safePlay(video: HTMLVideoElement) {
  try {
    const playback = video.play();
    if (typeof playback?.catch === 'function') {
      void playback.catch(() => {});
    }
  } catch {
    // Ignore autoplay/playback failures in preview surfaces.
  }
}

export function HoverVideo({
  src,
  poster,
  className,
  autoPlay = false,
}: {
  src: string;
  poster?: string | null;
  className?: string;
  autoPlay?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasPlayingRef = useRef(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const { prefersReducedMotion, saveData } = useMediaLoadingPreferences();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: '320px 0px', threshold: 0 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const shouldPlay = (isNearViewport || isHovering)
    && !prefersReducedMotion
    && !saveData
    && (autoPlay || isHovering);
  const attachedSrc = shouldPlay ? src : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (shouldPlay) {
      wasPlayingRef.current = true;
      safePlay(video);
      return;
    }

    if (!wasPlayingRef.current) {
      return;
    }
    wasPlayingRef.current = false;
    video.pause();
    if (video.currentTime) {
      video.currentTime = 0;
    }
  }, [attachedSrc, shouldPlay]);

  return (
    <video
      ref={videoRef}
      src={attachedSrc}
      poster={poster ? buildOptimizedPreviewImageUrl(poster) : undefined}
      muted
      loop
      playsInline
      preload="none"
      autoPlay={shouldPlay}
      aria-hidden="true"
      className={className}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    />
  );
}
