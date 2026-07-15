'use client';

import Image from 'next/image';
import { useState, type SyntheticEvent } from 'react';

interface OptimizedPreviewImageProps {
  previewSrc: string;
  fallbackSrc?: string | null;
  alt: string;
  sizes: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  priority?: boolean;
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
}

function getSupabaseStorageHost(): string | null {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredUrl) {
    return null;
  }

  try {
    return new URL(configuredUrl).hostname;
  } catch {
    return null;
  }
}

const supabaseStorageHost = getSupabaseStorageHost();

export function canOptimizePreviewImage(src: string): boolean {
  if (src.startsWith('/')) {
    return true;
  }

  if (!supabaseStorageHost) {
    return false;
  }

  try {
    const url = new URL(src);
    return url.protocol === 'https:'
      && url.hostname === supabaseStorageHost
      && url.pathname.startsWith('/storage/v1/object/');
  } catch {
    return false;
  }
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
  onLoad,
}: OptimizedPreviewImageProps) {
  const [failedPreviewSrc, setFailedPreviewSrc] = useState<string | null>(null);
  const previewFailed = failedPreviewSrc === previewSrc;

  const src = previewFailed && fallbackSrc ? fallbackSrc : previewSrc;
  const canFallback = Boolean(!previewFailed && fallbackSrc && fallbackSrc !== previewSrc);
  const handleError = () => {
    if (canFallback) {
      setFailedPreviewSrc(previewSrc);
    }
  };

  if (canOptimizePreviewImage(src)) {
    return (
      <Image
        key={src}
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
