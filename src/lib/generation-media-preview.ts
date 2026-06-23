import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { getMediaContentHash, getPreviewThumbhash } from '@/lib/media-preview-metadata';

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
    .upload(location.filePath, preview, {
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(preview),
    previewStatus: 'ready' as const,
  };
}

function getStorageLocation(storagePath: string) {
  const normalized = storagePath.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  return {
    bucket: normalized.slice(0, slashIndex),
    filePath: normalized.slice(slashIndex + 1),
  };
}
