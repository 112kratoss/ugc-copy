import { stat } from 'node:fs/promises';

import type { SupabaseClient } from '@supabase/supabase-js';
import sharp, { type Sharp } from 'sharp';

import { assertStoredPreviewIsIntact } from '@/lib/media-preview-integrity';
export { isDecodableWebp } from '@/lib/media-preview-integrity';

import { buildDisplayRenditionPath, encodeDisplayRendition } from '@/lib/media-display-rendition';
import { getMediaContentHash, getPreviewThumbhash } from '@/lib/media-preview-metadata';
import { toUsablePreviewSize } from '@/lib/preview-dimensions';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import { getStorageLocation } from '@/lib/storage-path';
import { toStorageUploadBody } from '@/lib/storage-upload-body';

const PREVIEW_MAX_SIZE = 720;

export function buildGenerationPreviewPath(storagePath: string, contentHash: string) {
  const normalized = storagePath.replace(/^\/+/, '');
  const extensionIndex = normalized.lastIndexOf('.');
  const slashIndex = normalized.lastIndexOf('/');
  const basePath = extensionIndex > slashIndex
    ? normalized.slice(0, extensionIndex)
    : normalized;
  return `${basePath}.preview.${contentHash}.webp`;
}

export function isImageGenerationPreview(category: string | null | undefined, contentType: string | null | undefined) {
  return category === 'image' || contentType?.startsWith('image/');
}

export function isVideoGenerationPreview(category: string | null | undefined, contentType: string | null | undefined) {
  return category === 'video' || category === 'motion' || contentType?.startsWith('video/');
}

export async function createGenerationImagePreview({
  body,
  storagePath,
  supabase,
}: {
  body: Blob;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const input = Buffer.from(await body.arrayBuffer());
  return createGenerationImageDerivatives({
    image: sharp(input).rotate(),
    sourceBytes: input.byteLength,
    storagePath,
    supabase,
  });
}

export async function createGenerationImagePreviewFromFile({
  filePath,
  storagePath,
  supabase,
}: {
  filePath: string;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const { size } = await stat(filePath);
  return createGenerationImageDerivatives({
    image: sharp(filePath).rotate(),
    sourceBytes: size,
    storagePath,
    supabase,
  });
}

/**
 * Both image sizes from one decode: the 720px grid preview, then the 1440px
 * display rendition the viewer opens instead of the source. The second size
 * costs one resize, not a second download — the same shape
 * `createPostMediaPreview` uses for published media.
 */
async function createGenerationImageDerivatives({
  image,
  sourceBytes,
  storagePath,
  supabase,
}: {
  image: Sharp;
  sourceBytes: number;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const metadata = await image.metadata();
  const preview = await image
    .clone()
    .resize({
      width: PREVIEW_MAX_SIZE,
      height: PREVIEW_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  const uploaded = await uploadGenerationPreview({ preview, storagePath, supabase });
  if (!uploaded) return null;

  const displayStoragePath = await uploadGenerationDisplayRendition({
    image,
    sourceBytes,
    width: metadata.width,
    height: metadata.height,
    storagePath,
    supabase,
  });
  return { ...uploaded, displayStoragePath };
}

/**
 * Uploads the display rendition beside the preview, in the same private
 * bucket, and returns its path — or null when one is not worth storing, which
 * is a normal answer: every reader falls back to the source for it.
 */
export async function uploadGenerationDisplayRendition({
  image,
  sourceBytes,
  width,
  height,
  storagePath,
  supabase,
}: {
  image: Sharp;
  sourceBytes: number;
  width: number | null | undefined;
  height: number | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}): Promise<string | null> {
  const display = await encodeDisplayRendition({ image, sourceBytes, width, height });
  if (!display) return null;

  const displayStoragePath = buildDisplayRenditionPath(storagePath.replace(/^\/+/, ''), display.storagePathHash);
  const location = getStorageLocation(displayStoragePath);
  if (!location) return null;

  const upload = await supabase.storage
    .from(location.bucket)
    .upload(location.filePath, toStorageUploadBody(display.body, 'image/webp'), {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: 'image/webp',
      upsert: true,
    });
  if (upload.error) {
    throw upload.error;
  }

  await assertStoredPreviewIsIntact({ supabase, location, expected: display.body });
  return displayStoragePath;
}

export async function uploadGenerationPreview({
  preview,
  storagePath,
  supabase,
}: {
  preview: Buffer;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const previewStoragePath = buildGenerationPreviewPath(storagePath, getMediaContentHash(preview));
  const location = getStorageLocation(previewStoragePath);
  if (!location) return null;

  const upload = await supabase.storage
    .from(location.bucket)
    .upload(location.filePath, toStorageUploadBody(preview, 'image/webp'), {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: 'image/webp',
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  await assertStoredPreviewIsIntact({ supabase, location, expected: preview });

  const { width, height } = await readPreviewDimensions(preview);

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(preview),
    previewStatus: 'ready' as const,
    /**
     * The preview's own pixel size, not the source output's. Previews are a
     * `fit: inside` resize, so the ratio is faithful while the absolute numbers
     * are the preview's — and ratio is all the showcase grid asks of them, to
     * size a card before the image arrives instead of resizing it afterwards.
     */
    previewWidth: width,
    previewHeight: height,
    /**
     * Set by the image path once its display rendition is uploaded. A video
     * poster has no display size — playback goes through the rendition — so
     * it stays null here, and every writer records the field either way.
     */
    displayStoragePath: null as string | null,
  };
}

async function readPreviewDimensions(preview: Buffer) {
  try {
    const metadata = await sharp(preview).metadata();
    const size = toUsablePreviewSize(metadata.width, metadata.height);
    return { width: size?.width ?? null, height: size?.height ?? null };
  } catch {
    // A preview whose header sharp cannot read is still a preview: the bytes
    // round-tripped intact through the check above, so a missing ratio must not
    // fail the upload and burn the row's retry budget. The client falls back to
    // measuring, exactly as it did before these columns existed.
    return { width: null, height: null };
  }
}

