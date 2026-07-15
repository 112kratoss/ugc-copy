const DEFAULT_OPTIMIZED_PREVIEW_WIDTH = 750;
const DEFAULT_OPTIMIZED_PREVIEW_QUALITY = 75;

function getSupabaseStorageOrigin(): string | null {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredUrl) {
    return null;
  }

  try {
    return new URL(configuredUrl).origin;
  } catch {
    return null;
  }
}

const supabaseStorageOrigin = getSupabaseStorageOrigin();

export function isGeneratedPreviewImage(src: string): boolean {
  if (!supabaseStorageOrigin) {
    return false;
  }

  try {
    const url = new URL(src);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.origin === supabaseStorageOrigin
      && url.pathname.startsWith('/storage/v1/object/')
      && /\.preview\.[a-f0-9]{8,}\.webp$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function canOptimizePreviewImage(src: string): boolean {
  if (/^\/(?!\/)/.test(src) && !src.includes('\\')) {
    return true;
  }

  if (!supabaseStorageOrigin) {
    return false;
  }

  try {
    const url = new URL(src);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.origin === supabaseStorageOrigin
      && url.pathname.startsWith('/storage/v1/object/');
  } catch {
    return false;
  }
}

/**
 * Builds the same same-origin URL used by Next Image for a single responsive
 * preview candidate. This is useful for video poster attributes, which cannot
 * consume an image srcset but should still avoid downloading full-size source
 * media or opening another origin connection on the critical path.
 */
export function buildOptimizedPreviewImageUrl(src: string): string {
  // Preview workers already emit bounded WebP files. Sending those through
  // Next's optimizer again adds a cold transformation hop without shrinking
  // the response, which delays the first video poster on new deployments.
  if (isGeneratedPreviewImage(src)) {
    return src;
  }

  if (!canOptimizePreviewImage(src)) {
    return src;
  }

  const params = new URLSearchParams({
    url: src,
    w: String(DEFAULT_OPTIMIZED_PREVIEW_WIDTH),
    q: String(DEFAULT_OPTIMIZED_PREVIEW_QUALITY),
  });

  return `/_next/image?${params.toString()}`;
}
