import 'server-only';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  isPostResourceBundleAccessMode,
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import {
  getMarketplaceQualityErrorForPostBundle,
  updatePostWithResourceBundleAtomically,
} from '@/lib/post-resource-bundles-server';
import { PostSourceToolsWriteError, replacePostSourceTools } from '@/lib/post-source-tools-server';
import { isMissingPostResourceBundlesSchemaError } from '@/lib/posts-server';
import {
  getMediaKindFromContentType,
  MAX_POST_MEDIA_ITEMS,
  replacePostMediaItems,
  type PostMediaPersistInput,
} from '@/lib/post-media';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createPostMediaRendition, type PostMediaRenditionStatus } from '@/lib/post-media-rendition';
import { defaultPostMediaKey, normalizePostMediaKey } from '@/lib/post-media-key';
import { isCreatorProfileCheckError } from '@/lib/marketplace-trust';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import {
  getPublicUgcSafetyViolation,
  PUBLIC_UGC_SAFETY_ERROR,
} from '@/lib/public-ugc-safety';
import {
  normalizeSourceToolInputWithCatalog,
  normalizeSourceToolSelectionsWithCatalog,
  validateSourceToolSelections,
} from '@/lib/source-tools';
import {
  isShowcaseItemCategory,
  type RawShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const UPLOADS_BUCKET = 'uploads';

type MutablePostRow = {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: ShowcaseVisibility;
  title: string | null;
  description: string | null;
  prompt: string | null;
  body: string | null;
  category: string;
  post_format: 'text' | 'media' | 'mixed';
  source_tool: string | null;
  source_tool_slug: string | null;
  source_kind: RawShowcaseSourceKind;
  archived_at: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
  review_status: 'visible' | 'flagged' | 'hidden' | null;
};

type BundleStatusRow = {
  access_mode: 'none' | 'free' | 'paid';
  status: 'draft' | 'published';
  resource_items?: unknown;
  resource_sections?: unknown;
};

type ExistingPostMediaRow = {
  id: string;
  media_key?: string | null;
  storage_path: string | null;
  preview_storage_path?: string | null;
  preview_thumbhash?: string | null;
  preview_status?: 'pending' | 'processing' | 'ready' | 'failed';
  preview_attempt_count?: number;
  preview_error?: string | null;
  preview_generated_at?: string | null;
  rendition_storage_path?: string | null;
  rendition_status?: PostMediaRenditionStatus;
  rendition_attempt_count?: number;
  rendition_error?: string | null;
  rendition_generated_at?: string | null;
  rendition_bytes?: number | null;
  external_url: string | null;
  media_kind: 'image' | 'video';
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  sort_order: number;
};

type SubmittedEditMediaItem =
  | { source: 'existing'; row: ExistingPostMediaRow; mediaKey: string }
  | {
      source: 'uploaded';
      mediaKey: string;
      filePath: string;
      temporaryStoragePath: string;
      originalName: string;
      contentType: string;
      mediaKind: 'image' | 'video';
    };

export type PostUpdateRequestBody = {
  title?: unknown;
  description?: unknown;
  body?: unknown;
  visibility?: unknown;
  category?: unknown;
  sourceTool?: unknown;
  sourceToolSlug?: unknown;
  sourceTools?: unknown;
  mediaItems?: unknown;
  resourceBundle?: unknown;
};

export type PostUpdateDependencies = {
  getMarketplaceQualityErrorForPostBundle?: typeof getMarketplaceQualityErrorForPostBundle;
  updatePostWithResourceBundleAtomically?: typeof updatePostWithResourceBundleAtomically;
  replacePostSourceTools?: typeof replacePostSourceTools;
  replacePostMediaItems?: typeof replacePostMediaItems;
  createPostMediaPreview?: typeof createPostMediaPreview;
  createPostMediaRendition?: typeof createPostMediaRendition;
  listSourceToolsCatalog?: typeof listSourceToolsCatalog;
};

type ResolvedPostUpdateDependencies = Required<PostUpdateDependencies>;

export type PostUpdateRouteResult =
  | {
      ok: true;
      body: {
        success: true;
        postId: string;
        visibility: ShowcaseVisibility;
        showcasePath: string | null;
        ownerPath: string;
        resourceBundlePath: string;
        resourceBundleStatus: 'draft' | 'published' | null;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      body: {
        error: string;
        field?: string;
      };
    }
  | {
      ok: false;
      status: 429;
      rateLimitError: BackendRateLimitError;
      body: {
        error: string;
        code: 'RATE_LIMITED';
        retryAfterSeconds: number;
        limit: number;
        resetAt: string;
      };
    };

function resolveDependencies(dependencies: PostUpdateDependencies | undefined): ResolvedPostUpdateDependencies {
  return {
    getMarketplaceQualityErrorForPostBundle:
      dependencies?.getMarketplaceQualityErrorForPostBundle ?? getMarketplaceQualityErrorForPostBundle,
    updatePostWithResourceBundleAtomically:
      dependencies?.updatePostWithResourceBundleAtomically ?? updatePostWithResourceBundleAtomically,
    replacePostSourceTools: dependencies?.replacePostSourceTools ?? replacePostSourceTools,
    replacePostMediaItems: dependencies?.replacePostMediaItems ?? replacePostMediaItems,
    createPostMediaPreview: dependencies?.createPostMediaPreview ?? createPostMediaPreview,
    createPostMediaRendition: dependencies?.createPostMediaRendition ?? createPostMediaRendition,
    listSourceToolsCatalog: dependencies?.listSourceToolsCatalog ?? listSourceToolsCatalog,
  };
}

function sanitizeFileStem(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const sanitized = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'upload';
}

function inferExtension(fileName: string, mimeType: string): string {
  const extension = path.extname(fileName).replace('.', '').toLowerCase();
  if (extension) {
    return extension;
  }

  return mimeType.startsWith('video/') ? 'mp4' : 'jpg';
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBody(value: unknown): string | null {
  return typeof value === 'string' && value.replace(/\r\n/g, '\n').trim()
    ? value.replace(/\r\n/g, '\n').trim()
    : null;
}

function normalizeVisibility(value: unknown): ShowcaseVisibility | null {
  if (value === 'public' || value === 'unlisted' || value === 'private') {
    return value;
  }

  return null;
}

function resourceBundleUsesMediaScope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const resources = (value as { resources?: unknown }).resources;
  if (!resources || typeof resources !== 'object') {
    return false;
  }

  const typedResources = resources as { items?: unknown; sections?: unknown };
  return [typedResources.items, typedResources.sections].some((entries) => (
    Array.isArray(entries)
    && entries.some((entry) => (
      Boolean(entry && typeof entry === 'object' && (entry as { scope?: { kind?: unknown } }).scope?.kind === 'media')
    ))
  ));
}

function collectScopedMediaKeys(...values: unknown[]): Set<string> {
  const mediaKeys = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const scope = (entry as { scope?: unknown }).scope;
      if (!scope || typeof scope !== 'object' || (scope as { kind?: unknown }).kind !== 'media') {
        continue;
      }
      const rawMediaKeys = (scope as { mediaKeys?: unknown }).mediaKeys;
      if (!Array.isArray(rawMediaKeys)) {
        continue;
      }
      for (const rawMediaKey of rawMediaKeys) {
        const mediaKey = normalizePostMediaKey(rawMediaKey);
        if (mediaKey) {
          mediaKeys.add(mediaKey);
        }
      }
    }
  }
  return mediaKeys;
}

function parseBundleInput(
  value: unknown,
  ownerUserId: string,
  mediaKeys: Iterable<string>
): { bundle: PostResourceBundleInput | null; error: string | null } {
  if (value == null) {
    return {
      bundle: null,
      error: null,
    };
  }

  if (typeof value !== 'object') {
    return {
      bundle: null,
      error: 'Invalid unlock payload.',
    };
  }

  const bundle = value as PostResourceBundleInput;
  if (!isPostResourceBundleAccessMode(bundle.accessMode)) {
    return {
      bundle: null,
      error: 'Choose whether the unlock should be free or paid.',
    };
  }

  const validationError = validatePostResourceBundleInput(bundle, { ownerUserId, mediaKeys });
  if (validationError) {
    return {
      bundle: null,
      error: validationError,
    };
  }

  return {
    bundle,
    error: null,
  };
}

async function loadOwnedPost(
  adminSupabase: SupabaseClient,
  postId: string,
  ownerUserId: string,
): Promise<MutablePostRow | null> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, visibility, title, description, prompt, body, category, post_format, source_tool, source_tool_slug, source_kind, archived_at, showcase_asset_path, output_url, review_status',
    )
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as MutablePostRow | null) ?? null;
}

async function loadOwnedBundleStatus(
  adminSupabase: SupabaseClient,
  postId: string,
  ownerUserId: string,
): Promise<BundleStatusRow | null> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('access_mode, status, resource_items, resource_sections')
    .eq('post_id', postId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();

  if (error && !isMissingPostResourceBundlesSchemaError(error)) {
    throw error;
  }

  return (data as BundleStatusRow | null) ?? null;
}

async function loadOwnedPostMedia(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<ExistingPostMediaRow[]> {
  const BASE_COLUMNS = 'id, storage_path, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order';
  const PREVIEW_COLUMNS = 'preview_storage_path, preview_thumbhash, preview_status, preview_attempt_count, preview_error, preview_generated_at';
  const RENDITION_COLUMNS = 'rendition_storage_path, rendition_status, rendition_attempt_count, rendition_error, rendition_generated_at, rendition_bytes';

  const selectOwnedMedia = (columns: string) => adminSupabase
    .from('post_media')
    .select(columns)
    .eq('post_id', postId)
    .order('sort_order', { ascending: true });

  const isMissingColumn = (candidate: typeof previewResult.error, pattern: RegExp) => Boolean(
    candidate
    && (candidate.code === '42703' || candidate.code === 'PGRST204')
    && pattern.test(candidate.message),
  );

  const previewResult = await selectOwnedMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}, ${RENDITION_COLUMNS}`);
  let data = previewResult.data as ExistingPostMediaRow[] | null;
  let error = previewResult.error;

  if (isMissingColumn(error, /rendition_(storage_path|status|attempt_count|error|generated_at|bytes)/)) {
    const withoutRendition = await selectOwnedMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}`);
    data = withoutRendition.data as ExistingPostMediaRow[] | null;
    error = withoutRendition.error;
  }

  if (isMissingColumn(error, /media_key/)) {
    const keylessPreviewResult = await selectOwnedMedia(`${BASE_COLUMNS}, ${PREVIEW_COLUMNS}`);
    data = keylessPreviewResult.data as ExistingPostMediaRow[] | null;
    error = keylessPreviewResult.error;
  }

  if (isMissingColumn(error, /preview_(storage_path|thumbhash|status|attempt_count|error|generated_at)/)) {
    const legacyResult = await selectOwnedMedia(BASE_COLUMNS);
    data = legacyResult.data as ExistingPostMediaRow[] | null;
    error = legacyResult.error;
  }

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function parseSubmittedEditMediaItems(params: {
  adminSupabase: SupabaseClient;
  value: unknown;
  postId: string;
  ownerUserId: string;
}): Promise<{ items: SubmittedEditMediaItem[] | null; error: string | null }> {
  if (params.value === undefined) {
    return { items: null, error: null };
  }

  if (!Array.isArray(params.value)) {
    return { items: null, error: 'Post media metadata is invalid.' };
  }

  if (params.value.length === 0) {
    return { items: null, error: 'Media posts need at least one image or video.' };
  }

  if (params.value.length > MAX_POST_MEDIA_ITEMS) {
    return { items: null, error: `Add up to ${MAX_POST_MEDIA_ITEMS} media items per post.` };
  }

  const existingRows = await loadOwnedPostMedia(params.adminSupabase, params.postId);
  const existingRowsMap = new Map(existingRows.map((row) => [row.id, row]));
  const submitted: SubmittedEditMediaItem[] = [];
  const submittedMediaKeys = new Set<string>();

  for (const value of params.value) {
    if (!value || typeof value !== 'object') {
      return { items: null, error: 'Post media metadata is invalid.' };
    }

    const descriptor = value as Record<string, unknown>;
    if (typeof descriptor.existingId === 'string') {
      const existingRow = existingRowsMap.get(descriptor.existingId);
      if (!existingRow) {
        return { items: null, error: 'An existing media item no longer belongs to this post.' };
      }
      const mediaKey = normalizePostMediaKey(existingRow.media_key) ?? defaultPostMediaKey(existingRow.sort_order);
      const requestedMediaKey = descriptor.mediaKey == null ? mediaKey : normalizePostMediaKey(descriptor.mediaKey);
      if (!requestedMediaKey || requestedMediaKey !== mediaKey) {
        return { items: null, error: 'Existing post media keys cannot be changed.' };
      }
      if (submittedMediaKeys.has(mediaKey)) {
        return { items: null, error: 'Post media keys must be unique.' };
      }
      submittedMediaKeys.add(mediaKey);
      submitted.push({ source: 'existing', row: existingRow, mediaKey });
      continue;
    }

    const mediaKey = descriptor.mediaKey == null ? randomUUID() : normalizePostMediaKey(descriptor.mediaKey);
    if (!mediaKey) {
      return { items: null, error: 'Post media keys may only use letters, numbers, hyphens, and underscores.' };
    }
    if (submittedMediaKeys.has(mediaKey)) {
      return { items: null, error: 'Post media keys must be unique.' };
    }
    submittedMediaKeys.add(mediaKey);

    const storagePath = typeof descriptor.storagePath === 'string'
      ? descriptor.storagePath.trim().replace(/^\/+/, '')
      : '';
    const expectedPrefix = `${UPLOADS_BUCKET}/${params.ownerUserId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      return { items: null, error: 'Uploaded media must belong to the authenticated user.' };
    }

    const contentType = typeof descriptor.contentType === 'string' ? descriptor.contentType.trim() : '';
    const mediaKind = getMediaKindFromContentType(contentType);
    if (!mediaKind) {
      return { items: null, error: 'Post media must be an image or video.' };
    }

    const originalName = typeof descriptor.originalName === 'string' && descriptor.originalName.trim()
      ? descriptor.originalName.trim()
      : path.basename(storagePath);
    const filePath = storagePath.slice(`${UPLOADS_BUCKET}/`.length);
    submitted.push({
      source: 'uploaded',
      mediaKey,
      filePath,
      temporaryStoragePath: filePath,
      originalName,
      contentType,
      mediaKind,
    });
  }

  return { items: submitted, error: null };
}

function createRateLimitResult(error: BackendRateLimitError): PostUpdateRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

async function replaceEditedPostMedia(params: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  submittedMediaItems: SubmittedEditMediaItem[];
  createPostMediaPreview: typeof createPostMediaPreview;
  createPostMediaRendition: typeof createPostMediaRendition;
  replacePostMediaItems: typeof replacePostMediaItems;
}): Promise<PostUpdateRouteResult | null> {
  const existingMediaRows = await loadOwnedPostMedia(params.adminSupabase, params.postId);
  const persistedMediaItems: PostMediaPersistInput[] = [];
  const newStoragePaths: string[] = [];
  const temporaryStoragePaths: string[] = [];

  try {
    for (const [index, item] of params.submittedMediaItems.entries()) {
      if (item.source === 'existing') {
        persistedMediaItems.push({
          mediaKey: item.mediaKey,
          storagePath: item.row.storage_path,
          previewStoragePath: item.row.preview_storage_path ?? null,
          previewThumbhash: item.row.preview_thumbhash ?? null,
          previewStatus: item.row.preview_status ?? (item.row.preview_storage_path ? 'ready' : 'pending'),
          previewAttemptCount: item.row.preview_attempt_count ?? 0,
          previewError: item.row.preview_error ?? null,
          previewGeneratedAt: item.row.preview_generated_at ?? null,
          // replace_post_media deletes and re-inserts, so an untouched item has
          // to carry its rendition across or every edit would discard it and
          // force a needless re-encode.
          renditionStoragePath: item.row.rendition_storage_path ?? null,
          renditionStatus: item.row.rendition_status
            ?? (item.row.media_kind === 'video' ? 'pending' : 'skipped'),
          renditionAttemptCount: item.row.rendition_attempt_count ?? 0,
          renditionError: item.row.rendition_error ?? null,
          renditionGeneratedAt: item.row.rendition_generated_at ?? null,
          renditionBytes: item.row.rendition_bytes ?? null,
          externalUrl: item.row.external_url,
          mediaKind: item.row.media_kind,
          contentType: item.row.content_type,
          originalName: item.row.original_name,
          width: item.row.width,
          height: item.row.height,
          durationSeconds: item.row.duration_seconds,
          sortOrder: index,
        });
        continue;
      }

      const downloadedMedia = await params.adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .download(item.filePath);
      if (downloadedMedia.error || !downloadedMedia.data) {
        throw new Error('Failed to load uploaded media.');
      }

      const extension = inferExtension(item.originalName, item.contentType);
      const storagePath = `posts/${params.postId}/${randomUUID()}/${sanitizeFileStem(item.originalName)}.${extension}`;
      const uploadResult = await params.adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(storagePath, downloadedMedia.data, {
          cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
          contentType: downloadedMedia.data.type || item.contentType || undefined,
          upsert: false,
        });
      if (uploadResult.error) {
        throw uploadResult.error;
      }

      newStoragePaths.push(storagePath);
      temporaryStoragePaths.push(item.temporaryStoragePath);
      let preview: Awaited<ReturnType<typeof createPostMediaPreview>> = null;
      try {
        preview = await params.createPostMediaPreview({
          body: downloadedMedia.data,
          contentType: item.contentType || downloadedMedia.data.type,
          storagePath,
          supabase: params.adminSupabase,
        });
        if (preview?.previewStoragePath) {
          newStoragePaths.push(preview.previewStoragePath);
        }
      } catch (previewError) {
        logBackendWarning('failed_to_create_edited_post_media_preview', { error: previewError });
      }

      let rendition: Awaited<ReturnType<typeof createPostMediaRendition>> | null = null;
      let renditionFailed = false;
      try {
        rendition = await params.createPostMediaRendition({
          body: downloadedMedia.data,
          contentType: item.contentType || downloadedMedia.data.type,
          storagePath,
          supabase: params.adminSupabase,
        });
        if (rendition.status === 'ready') {
          newStoragePaths.push(rendition.renditionStoragePath);
        }
      } catch (renditionError) {
        renditionFailed = true;
        logBackendWarning('failed_to_create_edited_post_media_rendition', { error: renditionError });
      }

      persistedMediaItems.push({
        mediaKey: item.mediaKey,
        storagePath,
        previewStoragePath: preview?.previewStoragePath ?? null,
        previewThumbhash: preview?.previewThumbhash ?? null,
        previewStatus: preview?.previewStatus ?? 'failed',
        previewAttemptCount: 1,
        previewError: preview ? null : 'Preview generation failed.',
        previewGeneratedAt: preview ? new Date().toISOString() : null,
        renditionStoragePath: rendition?.status === 'ready' ? rendition.renditionStoragePath : null,
        renditionStatus: rendition?.status === 'ready'
          ? 'ready'
          : rendition?.status === 'skipped'
            ? 'skipped'
            : renditionFailed
              ? 'failed'
              : item.mediaKind === 'video' ? 'pending' : 'skipped',
        renditionAttemptCount: item.mediaKind === 'video' ? 1 : 0,
        renditionError: renditionFailed ? 'Rendition generation failed.' : null,
        renditionGeneratedAt: rendition?.status === 'ready' ? new Date().toISOString() : null,
        renditionBytes: rendition?.status === 'ready' ? rendition.renditionBytes : null,
        externalUrl: null,
        mediaKind: item.mediaKind,
        contentType: item.contentType,
        originalName: item.originalName,
        width: preview?.width ?? (rendition?.status === 'ready' ? rendition.width : null),
        height: preview?.height ?? (rendition?.status === 'ready' ? rendition.height : null),
        durationSeconds: rendition?.status === 'ready' ? rendition.durationSeconds : null,
        sortOrder: index,
      });
    }

    await params.replacePostMediaItems({
      supabase: params.adminSupabase,
      postId: params.postId,
      ownerUserId: params.ownerUserId,
      mediaItems: persistedMediaItems,
    });

    if (temporaryStoragePaths.length > 0) {
      const temporaryCleanup = await params.adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .remove(temporaryStoragePaths);
      if (temporaryCleanup.error) {
        logBackendWarning('failed_to_remove_temporary_post_media_after_edit', { error: temporaryCleanup.error });
      }
    }

    const retainedStoragePaths = new Set(
      persistedMediaItems
        .flatMap((item) => [item.storagePath, item.previewStoragePath])
        .filter((storagePath): storagePath is string => Boolean(storagePath)),
    );
    const removedStoragePaths = existingMediaRows
      .flatMap((row) => [row.storage_path, row.preview_storage_path])
      .filter((storagePath): storagePath is string =>
        Boolean(storagePath) && !retainedStoragePaths.has(storagePath as string),
      );
    if (removedStoragePaths.length > 0) {
      const removedMediaCleanup = await params.adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .remove(removedStoragePaths);
      if (removedMediaCleanup.error) {
        logBackendWarning('failed_to_remove_deleted_post_media', { error: removedMediaCleanup.error });
      }
    }
  } catch (mediaError) {
    logBackendError('failed_to_update_post_media', { error: mediaError });
    if (newStoragePaths.length > 0) {
      await params.adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove(newStoragePaths);
    }
    return { ok: false, status: 500, body: { error: 'Failed to update post media.' } };
  }

  return null;
}

export async function updateOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  postId,
  body,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  body: PostUpdateRequestBody;
  dependencies?: PostUpdateDependencies;
}): Promise<PostUpdateRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('failed_to_enforce_post_update_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to update post.' } };
  }

  let didMutate = false;

  try {
    const post = await loadOwnedPost(adminSupabase, postId, ownerUserId);
    if (!post) {
      return { ok: false, status: 404, body: { error: 'Post not found.' } };
    }
    if (post.review_status && post.review_status !== 'visible') {
      return {
        ok: false,
        status: 409,
        body: { error: 'This post is locked while a moderation decision is in effect.' },
      };
    }
    const existingBundle = await loadOwnedBundleStatus(adminSupabase, postId, ownerUserId);

    const hasResourceBundlePayload = Object.prototype.hasOwnProperty.call(body, 'resourceBundle');
    const touchesGenerationLockedFields = ['title', 'description', 'body', 'category', 'sourceTool', 'sourceToolSlug', 'sourceTools', 'mediaItems'].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key)
    );

    if (post.generation_id && touchesGenerationLockedFields) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Generation-backed posts should be updated through the generation publish flow.' },
      };
    }

    const { items: submittedMediaItems, error: submittedMediaItemsError } = await parseSubmittedEditMediaItems({
      adminSupabase,
      value: body.mediaItems,
      postId,
      ownerUserId,
    });
    if (submittedMediaItemsError) {
      return { ok: false, status: 400, body: { error: submittedMediaItemsError } };
    }

    const availableMediaKeys = submittedMediaItems
      ? submittedMediaItems.map((item) => item.mediaKey)
      : hasResourceBundlePayload && resourceBundleUsesMediaScope(body.resourceBundle)
        ? (await loadOwnedPostMedia(adminSupabase, postId)).map((row) => (
            normalizePostMediaKey(row.media_key) ?? defaultPostMediaKey(row.sort_order)
          ))
        : [];
    if (
      availableMediaKeys.length === 0
      && post.post_format !== 'text'
      && (post.showcase_asset_path || post.output_url)
    ) {
      availableMediaKeys.push(defaultPostMediaKey(0));
    }

    if (submittedMediaItems && !hasResourceBundlePayload && existingBundle) {
      const nextMediaKeySet = new Set(availableMediaKeys);
      const existingScopedMediaKeys = collectScopedMediaKeys(
        existingBundle.resource_items,
        existingBundle.resource_sections
      );
      if (Array.from(existingScopedMediaKeys).some((mediaKey) => !nextMediaKeySet.has(mediaKey))) {
        return {
          ok: false,
          status: 400,
          body: { error: 'Update the recipe media selections before removing proof media it references.' },
        };
      }
    }

    const { bundle: resourceBundle, error: resourceBundleError } = parseBundleInput(
      body.resourceBundle,
      ownerUserId,
      availableMediaKeys
    );
    if (resourceBundleError) {
      return { ok: false, status: 400, body: { error: resourceBundleError } };
    }

    const nextBody = Object.prototype.hasOwnProperty.call(body, 'body') ? normalizeBody(body.body) : post.body;
    if (post.post_format === 'text' && !nextBody) {
      return { ok: false, status: 400, body: { error: 'Text posts need a note or tip to save.' } };
    }

    const nextVisibility = normalizeVisibility(body.visibility) ?? post.visibility;

    if (
      nextVisibility === 'public' &&
      !hasResourceBundlePayload &&
      existingBundle &&
      existingBundle.access_mode !== 'none' &&
      existingBundle.status === 'draft'
    ) {
      return {
        ok: false,
        status: 400,
        body: { error: 'This post already has a draft unlock. Please resubmit the unlock payload when publishing so we can validate and publish it together.' },
      };
    }

    const nextCategory =
      post.post_format === 'text'
        ? 'text'
        : submittedMediaItems?.[0]
          ? submittedMediaItems[0].source === 'existing'
            ? submittedMediaItems[0].row.media_kind
            : submittedMediaItems[0].mediaKind
        : Object.prototype.hasOwnProperty.call(body, 'category') && isShowcaseItemCategory(body.category as string)
          ? body.category
          : post.category;
    const nextTitle = Object.prototype.hasOwnProperty.call(body, 'title') ? normalizeText(body.title) : post.title;
    const nextDescription = Object.prototype.hasOwnProperty.call(body, 'description')
      ? normalizeText(body.description)
      : post.description;
    const safetyViolation = nextVisibility !== 'private'
      ? getPublicUgcSafetyViolation({
          title: nextTitle,
          description: nextDescription,
          body: nextBody,
          prompt: post.prompt,
          resourcePrompt: resourceBundle?.resources?.promptText ?? null,
          resourceNotes: resourceBundle?.resources?.notesMarkdown ?? null,
        })
      : null;
    if (safetyViolation) {
      return {
        ok: false,
        status: 400,
        body: {
          error: PUBLIC_UGC_SAFETY_ERROR,
          field: safetyViolation.field,
        },
      };
    }
    const sourceToolCatalog = await resolvedDependencies.listSourceToolsCatalog();

    const updatePayload: Record<string, unknown> = {
      visibility: nextVisibility,
      category: nextCategory,
    };

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      updatePayload.title = nextTitle;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      updatePayload.description = nextDescription;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'body')) {
      updatePayload.body = nextBody;
      updatePayload.post_format = nextBody ? (post.post_format === 'media' ? 'mixed' : post.post_format) : post.post_format;
    }
    const hasSourceToolsPayload = Object.prototype.hasOwnProperty.call(body, 'sourceTools');
    let sourceToolsValidationError: string | null = null;
    const sourceTools = (() => {
      if (hasSourceToolsPayload) {
        if (!Array.isArray(body.sourceTools)) {
          return null;
        }
        const validationError = validateSourceToolSelections(body.sourceTools);
        if (validationError) {
          sourceToolsValidationError = validationError;
          return [];
        }
        return normalizeSourceToolSelectionsWithCatalog(sourceToolCatalog, body.sourceTools);
      }
      if (
        Object.prototype.hasOwnProperty.call(body, 'sourceTool') ||
        Object.prototype.hasOwnProperty.call(body, 'sourceToolSlug')
      ) {
        const normalized = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
          label: Object.prototype.hasOwnProperty.call(body, 'sourceTool') ? normalizeText(body.sourceTool) : post.source_tool,
          slug: normalizeText(body.sourceToolSlug),
        });
        if (normalized.label) {
          return [{ toolLabel: normalized.label, toolSlug: normalized.slug }];
        }
      }
      return [];
    })();

    if (sourceTools === null) {
      return { ok: false, status: 400, body: { error: 'Source tool metadata is invalid.' } };
    }
    if (sourceToolsValidationError) {
      return {
        ok: false,
        status: 400,
        body: {
          error: sourceToolsValidationError,
          field: 'sourceTools',
        },
      };
    }

    if (hasSourceToolsPayload) {
      updatePayload.source_tool = sourceTools[0]?.toolLabel ?? null;
      updatePayload.source_tool_slug = sourceTools[0]?.toolSlug ?? null;
    } else if (sourceTools.length > 0) {
      updatePayload.source_tool = sourceTools[0].toolLabel;
      updatePayload.source_tool_slug = sourceTools[0].toolSlug;
    } else if (
      Object.prototype.hasOwnProperty.call(body, 'sourceTool') ||
      Object.prototype.hasOwnProperty.call(body, 'sourceToolSlug')
    ) {
      const normalizedSourceTool = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
        label: Object.prototype.hasOwnProperty.call(body, 'sourceTool') ? normalizeText(body.sourceTool) : post.source_tool,
        slug: normalizeText(body.sourceToolSlug),
      });
      updatePayload.source_tool = normalizedSourceTool.label;
      updatePayload.source_tool_slug = normalizedSourceTool.slug;
    }

    const marketplaceQualityError = nextVisibility === 'public'
      ? await resolvedDependencies.getMarketplaceQualityErrorForPostBundle({
          supabase: adminSupabase,
          ownerUserId,
          post: {
            title: nextTitle,
            body: nextBody,
            visibility: nextVisibility,
            archivedAt: post.archived_at,
            reviewStatus: post.review_status ?? 'visible',
            showcaseAssetPath: post.showcase_asset_path,
            outputUrl: post.output_url,
          },
          bundle: hasResourceBundlePayload ? resourceBundle : null,
        })
      : null;

    if (marketplaceQualityError) {
      return {
        ok: false,
        status: isCreatorProfileCheckError(marketplaceQualityError) ? 500 : 400,
        body: { error: marketplaceQualityError },
      };
    }

    const updatedPost = await resolvedDependencies.updatePostWithResourceBundleAtomically({
      supabase: adminSupabase,
      postId,
      ownerUserId,
      patch: updatePayload,
      hasBundlePayload: hasResourceBundlePayload,
      bundle: resourceBundle,
    });
    didMutate = true;

    if (submittedMediaItems) {
      const mediaError = await replaceEditedPostMedia({
        adminSupabase,
        ownerUserId,
        postId,
        submittedMediaItems,
        createPostMediaPreview: resolvedDependencies.createPostMediaPreview,
        createPostMediaRendition: resolvedDependencies.createPostMediaRendition,
        replacePostMediaItems: resolvedDependencies.replacePostMediaItems,
      });
      if (mediaError) {
        return mediaError;
      }
    }

    if (hasSourceToolsPayload) {
      try {
        await resolvedDependencies.replacePostSourceTools({
          supabase: adminSupabase,
          postId,
          ownerUserId,
          mediaKind: nextCategory === 'image'
            ? 'image'
            : nextCategory === 'video' || nextCategory === 'motion'
              ? 'video'
              : null,
          sourceTools,
        });
      } catch (sourceToolsError) {
        logBackendError('failed_to_replace_post_source_tools', { error: sourceToolsError });
        const isValidationError = sourceToolsError instanceof PostSourceToolsWriteError
          && sourceToolsError.isValidationError;
        return {
          ok: false,
          status: isValidationError ? 400 : 500,
          body: {
            error: isValidationError ? sourceToolsError.message : 'Failed to save source tool metadata.',
            field: isValidationError ? 'sourceTools' : undefined,
          },
        };
      }
    }

    return {
      ok: true,
      body: {
        success: true,
        postId,
        visibility: updatedPost.visibility,
        showcasePath: updatedPost.visibility === 'private' ? null : `/showcase/${postId}`,
        ownerPath: `/post/${postId}/edit`,
        resourceBundlePath:
          updatedPost.bundleStatus === 'draft' || updatedPost.visibility === 'private'
            ? `/post/${postId}/edit#recipe`
            : `/showcase/${postId}#recipe`,
        resourceBundleStatus: updatedPost.bundleStatus,
      },
    };
  } catch (error) {
    logBackendError('failed_to_update_owner_post', { error: error });
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return {
        ok: false,
        status: 500,
        body: { error: 'Posts are working, but atomic unlock publishing is not enabled yet. Apply the latest Supabase migrations and try again.' },
      };
    }
    return { ok: false, status: 500, body: { error: 'Failed to update post.' } };
  } finally {
    if (didMutate) {
      invalidateShowcaseFeedCache();
    }
  }
}
