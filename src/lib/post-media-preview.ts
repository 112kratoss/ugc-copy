import { PRIVATE_POST_MEDIA_BUCKET, postMediaStorageBucket } from '@/lib/post-media-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from '@/lib/image-decoder';

import { logBackendWarning } from '@/lib/backend-logger';
import { assertStoredPreviewIsIntact } from '@/lib/media-preview-integrity';

import { buildDisplayRenditionPath, encodeDisplayRendition } from '@/lib/media-display-rendition';
import { getMediaContentHash, getPreviewThumbhash } from '@/lib/media-preview-metadata';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import { toStorageUploadBody } from '@/lib/storage-upload-body';

const PREVIEW_MAX_SIZE = 720;

/**
 * The row size, a third picture beside the 720 px preview and the 1440 px
 * display copy: the short side of a WebP drawn in a search row's picture
 * frame (2026-11-23). The largest such frame is the web's 48 px model card,
 * and 48 px at 3x is 144; the app's are 28 to 40 dp. The long side follows
 * the picture's own shape (a 3:4 cover is 144 x 192), so a frame of any shape
 * can crop it. About 5 KB against the preview's 25 to 35 KB.
 */
export const POST_MEDIA_THUMB_SHORT_SIDE = 144;
const POST_MEDIA_THUMB_QUALITY = 72;

type PostMediaPreviewResult = {
  previewStoragePath: string;
  previewThumbhash: string;
  previewStatus: 'ready';
  width: number | null;
  height: number | null;
  /**
   * Null whenever a display rendition is not worth storing — a source that is
   * already display-sized, or one WebP cannot meaningfully shrink. Readers fall
   * back to the source, which is what they did before this existed.
   */
  displayStoragePath: string | null;
  /**
   * The row thumb made from this preview (`storePostMediaThumb`). Null unless
   * the caller asked for one (`withThumb`: only a writer that records it in
   * `post_media.thumb_storage_path`), for a source outside a creation's public
   * folder (`canStorePostMediaThumb`), and when it could not be made. A reader
   * then draws the preview, as it did before thumbs existed.
   */
  thumbStoragePath: string | null;
};

/**
 * Told the path of every object the call writes, or tries to: a write whose
 * reply is lost may still have landed. A caller that records the paths later
 * hands any it could not record to the revocation queue.
 */
type OnUploaded = (path: string) => void;

/** A derivative's name starts as its source's does, without the extension. */
function derivativeBasePath(storagePath: string) {
  const extensionIndex = storagePath.lastIndexOf('.');
  return extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
}

export function buildPostMediaPreviewPath(storagePath: string, contentHash: string) {
  return `${derivativeBasePath(storagePath)}.preview.${contentHash}.webp`;
}

/** Beside the source and its preview, so every folder rule that holds for them holds for it. */
export function buildPostMediaThumbPath(storagePath: string, contentHash: string) {
  return `${derivativeBasePath(storagePath)}.thumb.${contentHash}.webp`;
}

/**
 * The row thumb of a stored preview, encoded from the preview's own bytes: the
 * 720 px picture is five times the size asked for, so nothing is lost, and the
 * pipeline and the backfill (`backfill-post-media-thumbs.ts`) make the same
 * file from the same input. Never enlarged.
 */
export async function encodePostMediaThumb(preview: Buffer): Promise<Buffer> {
  return sharp(preview)
    .resize({
      width: POST_MEDIA_THUMB_SHORT_SIDE,
      height: POST_MEDIA_THUMB_SHORT_SIDE,
      fit: 'outside',
      withoutEnlargement: true,
    })
    .webp({ quality: POST_MEDIA_THUMB_QUALITY })
    .toBuffer();
}

/**
 * A creation's public folder, `showcase/<creation id>/`: the one place a thumb
 * is made, because it is the one place every path that drops a post's files
 * also reaches a thumb, through the revocation queue
 * (`queue_unrecorded_showcase_media` takes this same pattern). A post's own
 * folders (`posts/<post>/`, `private-posts/<post>/`) are not: account erasure
 * and a post's media edit list their objects by column, and no queue takes
 * them (review of #906). The database holds the same rule
 * (`post_media_thumb_beside_public_preview_check`).
 */
export const POST_MEDIA_THUMB_FOLDER_PATTERN = '^showcase/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]';
const CREATION_FOLDER_PATH = new RegExp(POST_MEDIA_THUMB_FOLDER_PATTERN);

/** Whether a row thumb may be made for media stored at `storagePath`: only in a creation's public folder. */
export function canStorePostMediaThumb(storagePath: string): boolean {
  return CREATION_FOLDER_PATH.test(storagePath);
}

/**
 * Encodes and stores the row thumb of the preview of `storagePath`, and
 * answers its path and size; null for a source outside a creation's public
 * folder (`canStorePostMediaThumb`), which includes all of the private
 * bucket, whose pictures nothing public draws. Throws when the upload fails
 * or its read-back disagrees, as the preview's does.
 */
export async function storePostMediaThumb({
  supabase,
  storagePath,
  preview,
  onUploaded,
}: {
  supabase: SupabaseClient;
  storagePath: string;
  preview: Buffer;
  onUploaded?: OnUploaded;
}): Promise<{ path: string; bytes: number } | null> {
  if (!canStorePostMediaThumb(storagePath)) return null;
  const bucket = postMediaStorageBucket(storagePath);
  if (bucket === PRIVATE_POST_MEDIA_BUCKET) return null;
  const thumb = await encodePostMediaThumb(preview);
  const thumbStoragePath = buildPostMediaThumbPath(storagePath, getMediaContentHash(thumb));
  const upload = await supabase.storage
    .from(bucket)
    .upload(thumbStoragePath, toStorageUploadBody(thumb, 'image/webp'), {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: 'image/webp',
      upsert: true,
    });
  onUploaded?.(thumbStoragePath);
  if (upload.error) throw upload.error;
  await assertStoredPreviewIsIntact({
    supabase,
    location: { bucket, filePath: thumbStoragePath },
    expected: thumb,
  });
  return { path: thumbStoragePath, bytes: thumb.byteLength };
}

/**
 * A thumb is an extra: one that cannot be made costs a search row its small
 * picture (it draws the preview instead), never the preview's attempt. The
 * backfill makes it later.
 */
async function storeThumbBesidePreview({
  withThumb,
  ...params
}: Parameters<typeof storePostMediaThumb>[0] & { withThumb: boolean }): Promise<string | null> {
  if (!withThumb) return null;
  try {
    return (await storePostMediaThumb(params))?.path ?? null;
  } catch (error) {
    logBackendWarning('post_media_thumb_not_stored', { storagePath: params.storagePath, error });
    return null;
  }
}

export async function createPostMediaImagePreview({
  body,
  contentType,
  storagePath,
  supabase,
  onUploaded,
  withThumb = false,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
  onUploaded?: OnUploaded;
  /** Make the row thumb too: only for a writer that records `thumb_storage_path`. */
  withThumb?: boolean;
}) {
  const resolvedContentType = contentType || body.type;
  if (!isImageMedia(resolvedContentType, storagePath)) {
    return null;
  }

  const input = Buffer.from(await body.arrayBuffer());
  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  // metadata() describes the stored pixels, before the rotate() above. A phone
  // photo stored 1200x800 with EXIF orientation 6 is drawn, and previewed,
  // 800x1200, and a card laid out from the stored size would be landscape.
  const { width, height } = metadata.autoOrient;
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
  const previewStoragePath = buildPostMediaPreviewPath(storagePath, getMediaContentHash(preview));
  const upload = await supabase.storage
    .from(postMediaStorageBucket(storagePath))
    .upload(previewStoragePath, toStorageUploadBody(preview, 'image/webp'), {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: 'image/webp',
      upsert: true,
    });
  onUploaded?.(previewStoragePath);

  if (upload.error) {
    throw upload.error;
  }

  await assertStoredPreviewIsIntact({
    supabase,
    location: { bucket: postMediaStorageBucket(storagePath), filePath: previewStoragePath },
    expected: preview,
  });

  const thumbStoragePath = await storeThumbBesidePreview({
    withThumb,
    supabase,
    storagePath,
    preview,
    onUploaded,
  });

  // Encoded from the same decode as the preview, so the extra size costs one
  // resize rather than a second download.
  const display = await encodeDisplayRendition({
    image,
    sourceBytes: input.byteLength,
    width,
    height,
  });
  let displayStoragePath: string | null = null;
  if (display) {
    displayStoragePath = buildDisplayRenditionPath(storagePath, display.storagePathHash);
    const displayUpload = await supabase.storage
      .from(postMediaStorageBucket(storagePath))
      .upload(displayStoragePath, toStorageUploadBody(display.body, 'image/webp'), {
        cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
        contentType: 'image/webp',
        upsert: true,
      });
    onUploaded?.(displayStoragePath);
    if (displayUpload.error) {
      throw displayUpload.error;
    }
    await assertStoredPreviewIsIntact({
      supabase,
      location: { bucket: postMediaStorageBucket(storagePath), filePath: displayStoragePath },
      expected: display.body,
    });
  }

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(preview),
    previewStatus: 'ready',
    width: width ?? null,
    height: height ?? null,
    displayStoragePath,
    thumbStoragePath,
  } satisfies PostMediaPreviewResult;
}

export async function createPostMediaPreview({
  body,
  contentType,
  storagePath,
  supabase,
  onUploaded,
  withThumb = false,
}: {
  body: Blob;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
  onUploaded?: OnUploaded;
  /** Make the row thumb too: only for a writer that records `thumb_storage_path`. */
  withThumb?: boolean;
}): Promise<PostMediaPreviewResult | null> {
  const resolvedContentType = contentType || body.type;

  if (isImageMedia(resolvedContentType, storagePath)) {
    return createPostMediaImagePreview({
      body,
      contentType: resolvedContentType,
      storagePath,
      supabase,
      onUploaded,
      withThumb,
    });
  }

  if (!isVideoMedia(resolvedContentType, storagePath)) {
    return null;
  }

  const { createVideoPosterBuffer } = await import('@/lib/video-poster');
  const poster = await createVideoPosterBuffer(body);
  const previewStoragePath = buildPostMediaPreviewPath(storagePath, getMediaContentHash(poster));
  const upload = await supabase.storage
    .from(postMediaStorageBucket(storagePath))
    .upload(previewStoragePath, toStorageUploadBody(poster, 'image/webp'), {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: 'image/webp',
      upsert: true,
    });
  onUploaded?.(previewStoragePath);

  if (upload.error) {
    throw upload.error;
  }

  await assertStoredPreviewIsIntact({
    supabase,
    location: { bucket: postMediaStorageBucket(storagePath), filePath: previewStoragePath },
    expected: poster,
  });

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(poster),
    previewStatus: 'ready',
    width: null,
    height: null,
    // A video's still is only ever a poster; the clip itself is what the
    // rendition pipeline shrinks.
    displayStoragePath: null,
    // A video row's picture in search is its poster's thumb.
    thumbStoragePath: await storeThumbBesidePreview({
      withThumb,
      supabase,
      storagePath,
      preview: poster,
      onUploaded,
    }),
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
