import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { createVideoPosterBuffer } from '@/lib/generation-media-preview';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const PREVIEW_MAX_SIZE = 720;

type PostMediaPreviewResult = {
  previewStoragePath: string;
  width: number | null;
  height: number | null;
};

export function buildPostMediaPreviewPath(storagePath: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.preview.webp`;
}

export async function createPostMediaImagePreview({
  body,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const resolvedContentType = contentType || body.type;
  if (!isImageMedia(resolvedContentType, storagePath)) {
    return null;
  }

  const input = Buffer.from(await body.arrayBuffer());
  const image = sharp(input).rotate();
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
  const previewStoragePath = buildPostMediaPreviewPath(storagePath);
  const upload = await supabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .upload(previewStoragePath, preview, {
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  return {
    previewStoragePath,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
  } satisfies PostMediaPreviewResult;
}

export async function createPostMediaPreview({
  body,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}): Promise<PostMediaPreviewResult | null> {
  const resolvedContentType = contentType || body.type;

  if (isImageMedia(resolvedContentType, storagePath)) {
    return createPostMediaImagePreview({
      body,
      contentType: resolvedContentType,
      storagePath,
      supabase,
    });
  }

  if (!isVideoMedia(resolvedContentType, storagePath)) {
    return null;
  }

  const previewStoragePath = buildPostMediaPreviewPath(storagePath);
  const poster = await createVideoPosterBuffer(body);
  const upload = await supabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .upload(previewStoragePath, poster, {
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  return {
    previewStoragePath,
    width: null,
    height: null,
  };
}

function isImageMedia(contentType: string | null | undefined, storagePath: string) {
  return contentType?.startsWith('image/')
    || /\.(avif|gif|jpe?g|png|webp)$/i.test(storagePath);
}

function isVideoMedia(contentType: string | null | undefined, storagePath: string) {
  return contentType?.startsWith('video/')
    || /\.(m4v|mov|mp4|webm)$/i.test(storagePath);
}
