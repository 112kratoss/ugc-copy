import 'server-only';

import { unstable_cache } from 'next/cache';

import { isGeneratedPreviewImage } from '@/lib/preview-images';

export const SHOWCASE_PRIORITY_POSTER_MAX_BYTES = 64 * 1024;
export const SHOWCASE_PRIORITY_POSTER_TIMEOUT_MS = 1_500;

const SHOWCASE_PRIORITY_POSTER_REVALIDATE_SECONDS = 24 * 60 * 60;
const PUBLIC_SHOWCASE_MEDIA_PREFIX = '/storage/v1/object/public/showcase_media/';
const SIGNED_GENERATED_MEDIA_PREFIX = '/storage/v1/object/sign/generated_images/';

export function isInlineableShowcasePriorityPoster(src: string): boolean {
  if (!isGeneratedPreviewImage(src)) {
    return false;
  }

  try {
    const url = new URL(src);
    if (url.hash !== '') return false;

    if (url.pathname.startsWith(PUBLIC_SHOWCASE_MEDIA_PREFIX)) {
      return url.search === '';
    }

    if (!url.pathname.startsWith(SIGNED_GENERATED_MEDIA_PREFIX)) {
      return false;
    }

    // Home hydration already emits a short-lived signed URL for private
    // generated previews. Permit exactly that token and no caller-controlled
    // extra parameters; the bytes are still bounded and signature-checked
    // before being embedded.
    const tokenValues = url.searchParams.getAll('token');
    return [...url.searchParams.keys()].every((key) => key === 'token')
      && tokenValues.length === 1
      && tokenValues[0].length > 0;
  } catch {
    return false;
  }
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (
      Number.isFinite(declaredLength)
      && declaredLength > SHOWCASE_PRIORITY_POSTER_MAX_BYTES
    ) {
      throw new Error('Showcase priority poster exceeds the inline size limit.');
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > SHOWCASE_PRIORITY_POSTER_MAX_BYTES) {
      throw new Error('Showcase priority poster exceeds the inline size limit.');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > SHOWCASE_PRIORITY_POSTER_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Showcase priority poster exceeds the inline size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

/**
 * Loads one already-bounded, generated WebP preview for server rendering.
 * Callers should normally use getInlineShowcasePriorityPoster so failures can
 * fall back to the normal external poster without breaking the page render.
 */
export async function fetchInlineShowcasePriorityPoster(
  src: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!isInlineableShowcasePriorityPoster(src)) {
    throw new Error('Showcase priority poster URL is not an allowed generated preview.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOWCASE_PRIORITY_POSTER_TIMEOUT_MS);

  try {
    const response = await fetchImpl(src, {
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Showcase priority poster returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'image/webp') {
      throw new Error('Showcase priority poster did not return image/webp.');
    }

    const bytes = await readBoundedResponseBody(response);
    if (!hasWebpSignature(bytes)) {
      throw new Error('Showcase priority poster did not contain a WebP signature.');
    }

    return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}

const getCachedInlineShowcasePriorityPoster = unstable_cache(
  fetchInlineShowcasePriorityPoster,
  ['showcase-priority-poster-v1'],
  { revalidate: SHOWCASE_PRIORITY_POSTER_REVALIDATE_SECONDS }
);

export async function getInlineShowcasePriorityPoster(src: string): Promise<string | null> {
  if (!isInlineableShowcasePriorityPoster(src)) {
    return null;
  }

  try {
    return await getCachedInlineShowcasePriorityPoster(src);
  } catch {
    // The public page must remain available when the preview origin or cache is
    // slow. Its existing external preview URL remains the rendering fallback.
    return null;
  }
}
