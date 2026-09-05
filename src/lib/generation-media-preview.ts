import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { assertStoredPreviewIsIntact } from '@/lib/media-preview-integrity';
export { isDecodableWebp } from '@/lib/media-preview-integrity';

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
  const preview = await sharp(input)
    .rotate()
    .resize({
      width: PREVIEW_MAX_SIZE,
      height: PREVIEW_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  return uploadGenerationPreview({ preview, storagePath, supabase });
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
  const preview = await sharp(filePath)
    .rotate()
    .resize({
      width: PREVIEW_MAX_SIZE,
      height: PREVIEW_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  return uploadGenerationPreview({ preview, storagePath, supabase });
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

