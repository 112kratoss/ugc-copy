import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { openAllowlistedRemoteMedia } from '@/lib/remote-media-security';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import type { ShowcaseItemCategory } from '@/lib/showcase';
import {
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

/**
 * The public media copy of a generation-backed post.
 *
 * While such a post is exposed (public or unlisted) its media is served from a
 * derivative in the public `showcase_media` bucket; while it is private the
 * derivative is removed and the post points at the owner's durable private
 * copy instead. The publish route and the post update route both move posts
 * between those states, so the work lives here rather than in either.
 */

export type GenerationShowcaseCategory = Exclude<ShowcaseItemCategory, 'text'>;

export const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

export function normalizeGenerationShowcaseCategory(
  value: string | null | undefined,
): GenerationShowcaseCategory | undefined {
  if (value === 'motion' || value === 'ugc-ad') return 'video';
  return value === 'image' || value === 'video' ? value : undefined;
}

export function getCanonicalGenerationShowcaseAssetPath(
  storagePath: string | null | undefined,
  generationId: string,
): string | null {
  if (!storagePath) return null;
  const canonicalPath = parseCanonicalStorageObjectPath(storagePath, { minimumSegments: 3 });
  return canonicalPath?.startsWith(`showcase/${generationId}/`) ? canonicalPath : null;
}

function isExistingStorageObjectError(error: { message?: string; statusCode?: string } | null) {
  return error?.statusCode === '409'
    || /already exists|duplicate/i.test(error?.message ?? '');
}

function inferExtension(sourceName: string, category: GenerationShowcaseCategory): string {
  const candidate = sourceName.split('.').pop();
  if (candidate && candidate.length <= 5) {
    return candidate;
  }

  if (category === 'image') return 'jpg';
  return 'mp4';
}

function inferShowcaseContentType(sourceName: string, category: GenerationShowcaseCategory) {
  const extension = path.extname(sourceName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  return category === 'image' ? 'image/jpeg' : 'video/mp4';
}

async function downloadStoredShowcaseSource(
  adminSupabase: SupabaseClient,
  bucket: string,
  filePath: string,
): Promise<{ body: Blob | ReadableStream<Uint8Array>; contentType: string | null }> {
  const builder = adminSupabase.storage.from(bucket).download(filePath);
  const streamBuilder = builder as typeof builder & {
    asStream?: () => PromiseLike<{
      data: ReadableStream<Uint8Array> | null;
      error: { message?: string } | null;
    }>;
  };

  if (typeof streamBuilder.asStream === 'function') {
    const { data, error } = await streamBuilder.asStream();
    if (error || !data) {
      throw new Error(`Failed to load source media from ${bucket}/${filePath}`);
    }
    return { body: data, contentType: null };
  }

  const { data, error } = await builder;
  if (error || !data) {
    throw new Error(`Failed to load source media from ${bucket}/${filePath}`);
  }
  return { body: data, contentType: data.type || null };
}

/**
 * Copies a generation's output into the public showcase bucket and returns the
 * derivative's storage path. The path is content-addressed from the source
 * URL, so publishing the same output twice is a no-op on the existing object.
 */
export async function createGenerationShowcaseDerivative({
  adminSupabase,
  category,
  generationId,
  ownerUserId,
  outputUrl,
  openRemoteMedia = openAllowlistedRemoteMedia,
}: {
  adminSupabase: SupabaseClient;
  category: GenerationShowcaseCategory;
  generationId: string;
  ownerUserId: string;
  outputUrl: string;
  openRemoteMedia?: typeof openAllowlistedRemoteMedia;
}): Promise<string> {
  const storedLocation = getUserOwnedStoredMediaLocation(outputUrl, ownerUserId);
  let fileBody: Blob | ReadableStream<Uint8Array>;
  let sourceName: string;
  let contentType: string | null = null;

  if (storedLocation) {
    sourceName = storedLocation.filePath.split('/').pop() || `${generationId}.${inferExtension(outputUrl, category)}`;
    const source = await downloadStoredShowcaseSource(
      adminSupabase,
      storedLocation.bucket,
      storedLocation.filePath,
    );
    fileBody = source.body;
    contentType = source.contentType;
  } else if (outputUrl.startsWith('http')) {
    const downloaded = await openRemoteMedia({
      url: outputUrl,
      kind: category,
    });
    sourceName = downloaded.sourceName || `${generationId}.${inferExtension(outputUrl, category)}`;
    fileBody = downloaded.body;
    contentType = downloaded.contentType;
  } else {
    throw new Error('Unsupported media source for showcase publishing');
  }

  const baseName = path.basename(sourceName, path.extname(sourceName)) || generationId;
  const sourceVersion = createHash('sha256').update(outputUrl).digest('hex').slice(0, 12);
  const showcaseAssetPath = `showcase/${generationId}/${baseName}.${sourceVersion}.${inferExtension(sourceName, category)}`;

  const { error: uploadError } = await adminSupabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .upload(showcaseAssetPath, fileBody, {
      cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
      contentType: contentType || inferShowcaseContentType(sourceName, category),
      upsert: false,
    });

  if (uploadError && !isExistingStorageObjectError(uploadError)) {
    throw new Error(`Failed to upload showcase derivative: ${uploadError.message}`);
  }

  return showcaseAssetPath;
}

/**
 * Removes a generation's public derivative once its post is private. Only a
 * path under the generation's own prefix is ever removed; anything else is
 * left alone rather than trusted.
 */
export async function removeGenerationShowcaseDerivative({
  adminSupabase,
  generationId,
  showcaseAssetPath,
  postId,
}: {
  adminSupabase: SupabaseClient;
  generationId: string;
  showcaseAssetPath: string | null | undefined;
  /**
   * The post the derivative served. Creation posts from before the 2026-06
   * gallery backfill carry post_media rows copied from their derivative
   * (newer ones carry none, and the owner's surfaces fall back to a signed URL
   * of the durable copy). Those rows' main, preview, rendition and teaser
   * objects all live in the public bucket, so they go with the derivative: a
   * row left behind would keep the owner's own list pointed at a URL that now
   * 404s while a downscaled copy stayed public.
   */
  postId?: string | null;
}): Promise<{
  removed: boolean;
  removedPaths: string[];
  removedMediaRows: number;
  error: { message?: string } | null;
}> {
  const removablePaths = new Set<string>();
  const derivativePath = getCanonicalGenerationShowcaseAssetPath(showcaseAssetPath, generationId);
  if (derivativePath) removablePaths.add(derivativePath);

  let removedMediaRows = 0;
  if (postId) {
    const { data, error: loadError } = await adminSupabase
      .from('post_media')
      .select('id, storage_path, preview_storage_path, rendition_storage_path, teaser_storage_path')
      .eq('post_id', postId);
    if (loadError) {
      return { removed: false, removedPaths: [], removedMediaRows: 0, error: loadError };
    }
    type LegacyMediaRow = {
      id: string;
      storage_path: string | null;
      preview_storage_path?: string | null;
      rendition_storage_path?: string | null;
      teaser_storage_path?: string | null;
    };
    const legacyRows = ((data ?? []) as LegacyMediaRow[]).filter((row) => (
      Boolean(getCanonicalGenerationShowcaseAssetPath(row.storage_path, generationId))
    ));
    for (const row of legacyRows) {
      for (const candidate of [row.storage_path, row.preview_storage_path, row.rendition_storage_path, row.teaser_storage_path]) {
        const canonicalPath = getCanonicalGenerationShowcaseAssetPath(candidate, generationId);
        if (canonicalPath) removablePaths.add(canonicalPath);
      }
    }
    if (legacyRows.length > 0) {
      // Rows go first so a row never outlives its objects; if the delete
      // fails the objects stay too and the row keeps working.
      const { error: deleteError } = await adminSupabase
        .from('post_media')
        .delete()
        .in('id', legacyRows.map((row) => row.id));
      if (deleteError) {
        return { removed: false, removedPaths: [], removedMediaRows: 0, error: deleteError };
      }
      removedMediaRows = legacyRows.length;
    }
  }

  if (removablePaths.size === 0) {
    return { removed: false, removedPaths: [], removedMediaRows, error: null };
  }
  const paths = [...removablePaths];
  const result = await adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove(paths);
  return {
    removed: !result.error,
    removedPaths: result.error ? [] : paths,
    removedMediaRows,
    error: result.error ?? null,
  };
}
