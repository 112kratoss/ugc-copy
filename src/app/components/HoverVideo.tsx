"use client";

import { useEffect, useRef } from 'react';

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
  className,
  autoPlay = false,
}: {
  src: string;
  className?: string;
  autoPlay?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoPlay) {
      return;
    }

    safePlay(video);
  }, [autoPlay, src]);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      loop
      playsInline
      preload="metadata"
      autoPlay={autoPlay}
      className={className}
      onMouseEnter={(e) => {
        if (autoPlay) {
          return;
        }

        safePlay(e.currentTarget);
      }}
      onMouseLeave={(e) => {
        if (autoPlay) {
          return;
        }

        e.currentTarget.pause();
        e.currentTarget.currentTime = 0;
      }}
    />
  );
}
