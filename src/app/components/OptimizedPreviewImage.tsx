'use client';

import Image from 'next/image';
import { useState, type SyntheticEvent } from 'react';

import { canOptimizePreviewImage } from '@/lib/preview-images';

interface OptimizedPreviewImageProps {
  previewSrc: string;
  fallbackSrc?: string | null;
  alt: string;
  sizes: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  priority?: boolean;
  fallbackToUnoptimized?: boolean;
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
  /** Fires once every source has been tried and none rendered. */
  onError?: () => void;
  /**
   * The underlying element, for callers that must read `naturalWidth` or
   * `complete` — a cached image can finish before React attaches `onLoad`.
   */
  imageRef?: (image: HTMLImageElement | null) => void;
}

/**
 * A fill-mode image for bounded card/media frames. Durable Supabase images use
 * Next's responsive optimizer; other providers keep their already-small preview
 * URL so an unlisted remote host cannot break rendering at runtime.
 */
export function OptimizedPreviewImage({
  previewSrc,
  fallbackSrc = null,
  alt,
  sizes,
  className = '',
  loading = 'lazy',
  priority = false,
  fallbackToUnoptimized = false,
  onLoad,
  onError,
  imageRef,
}: OptimizedPreviewImageProps) {
  const [failedPreviewSrc, setFailedPreviewSrc] = useState<string | null>(null);
  const [failedRenderedSrc, setFailedRenderedSrc] = useState<string | null>(null);
  const previewFailed = failedPreviewSrc === previewSrc;

  const src = previewFailed && fallbackSrc ? fallbackSrc : previewSrc;
  const isFallbackAttempt = Boolean(previewFailed && fallbackSrc);
  const renderedSrcFailed = failedRenderedSrc === src;
  const canFallback = Boolean(
    !previewFailed
    && fallbackSrc
    && (
      fallbackSrc !== previewSrc
      || (fallbackToUnoptimized && canOptimizePreviewImage(previewSrc))
    )
  );
  const handleError = () => {
    if (canFallback) {
      setFailedPreviewSrc(previewSrc);
      return;
    }

    setFailedRenderedSrc(src);
    onError?.();
  };

  if (renderedSrcFailed) {
    return null;
  }

  if (!(isFallbackAttempt && fallbackToUnoptimized) && canOptimizePreviewImage(src)) {
    return (
      <Image
        key={src}
        ref={imageRef}
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        loading={priority ? undefined : loading}
        priority={priority}
        fetchPriority={priority ? 'high' : undefined}
        onLoad={onLoad}
        onError={handleError}
        className={className}
      />
    );
  }

  return (
    // This fallback is intentional: Next Image rejects unconfigured external hosts.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      ref={imageRef}
      src={src}
      alt={alt}
      loading={priority ? 'eager' : loading}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      onLoad={onLoad}
      onError={handleError}
      className={`absolute inset-0 h-full w-full ${className}`}
    />
  );
}

export { canOptimizePreviewImage } from '@/lib/preview-images';
