import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { getMediaContentHash, getPreviewThumbhash } from '@/lib/media-preview-metadata';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
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

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(preview),
    previewStatus: 'ready' as const,
  };
}

/** A WebP file is a RIFF container: "RIFF" at byte 0 and "WEBP" at byte 8. */
export function isDecodableWebp(bytes: Uint8Array) {
  if (bytes.length < 12) return false;

  const header = Buffer.from(bytes.subarray(0, 12));
  return header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * Read the object back and prove the bytes that landed are the bytes we encoded.
 *
 * An upload that "succeeds" but stores a corrupt file is worse than one that fails:
 * the caller records `preview_status: 'ready'`, and the repair job only ever revisits
 * `pending`/`failed`/`processing` — so a silently mangled preview is never retried and
 * stays broken forever. Four production previews reached exactly that state: their
 * bytes had been round-tripped through a UTF-8 decode, which replaces every byte that
 * is not valid UTF-8 with U+FFFD (`EF BF BD`). That inflates the file and shifts the
 * RIFF header, so every client fails to decode it while the row still claims success.
 *
 * Length alone catches that class, because the substitution can only grow the file;
 * the magic-byte check additionally catches truncation and wrong-format writes.
 * Throwing here costs one small read and converts permanent silent breakage into an
 * ordinary retry.
 */
async function assertStoredPreviewIsIntact({
  supabase,
  location,
  expected,
}: {
  supabase: SupabaseClient;
  location: { bucket: string; filePath: string };
  expected: Buffer;
}) {
  const stored = await supabase.storage.from(location.bucket).download(location.filePath);

  if (stored.error || !stored.data) {
    throw stored.error ?? new Error(`Preview ${location.filePath} could not be read back after upload`);
  }

  const bytes = new Uint8Array(await stored.data.arrayBuffer());

  if (bytes.length !== expected.length) {
    throw new Error(
      `Preview ${location.filePath} stored ${bytes.length} bytes but ${expected.length} were encoded`
    );
  }

  if (!isDecodableWebp(bytes)) {
    throw new Error(`Preview ${location.filePath} is not a decodable WebP after upload`);
  }
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
