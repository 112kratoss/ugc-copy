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
import { TITLE_MAX_LENGTH, isMissingPostResourceBundlesSchemaError } from '@/lib/posts-server';
import {
  getMediaKindFromContentType,
  MAX_POST_MEDIA_ITEMS,
  replacePostMediaItems,
  type PostMediaPersistInput,
} from '@/lib/post-media';
import {
  getConfirmedRemovedPaths,
  markMediaUploadIntentsConsumed,
} from '@/lib/media-upload-intents';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { excludePurchasedProofMediaPaths } from '@/lib/purchased-proof-media';
import {
  formatUploadByteLimit,
  getMaxUploadBytesForContentType,
} from '@/lib/temporary-media-upload-sign';
import { type PostMediaRenditionStatus } from '@/lib/post-media-rendition';
import { defaultPostMediaKey, normalizePostMediaKey } from '@/lib/post-media-key';
import { POST_VIDEO_DURATION_LIMIT_MESSAGE, POST_VIDEO_MAX_DURATION_SECONDS } from '@/lib/post-video-limits';
import { isCreatorProfileCheckError } from '@/lib/marketplace-trust';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
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

/**
 * Raised when the bytes actually received exceed the limit for their media
 * kind. Distinct from the generic media failure so the caller gets a 400 it can
 * act on rather than a 500 that reads like an outage.
 */
class PostMediaTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostMediaTooLargeError';
  }
}

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
  id?: string;
  access_mode: 'none' | 'free' | 'paid';
  status: 'draft' | 'published';
  sales_count?: number | null;
  summary?: string | null;
  preview_text?: string | null;
  prompt_text?: string | null;
  notes_markdown?: string | null;
  workflow_share_url?: string | null;
  workflow_snapshot?: unknown;
  attachments?: unknown;
  allow_remix?: boolean | null;
  price_usd_cents?: number | null;
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
  teaser_storage_path?: string | null;
  teaser_bytes?: number | null;
  teaser_generated_at?: string | null;
  teaser_error?: string | null;
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
      /** Client-reported seed; the rendition sweep's probe overwrites it. */
      durationSeconds?: number | null;
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
        code?: string;
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
    .select(
      'id, access_mode, status, sales_count, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, resource_items, resource_sections',
    )
    .eq('post_id', postId)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();

  if (error && !isMissingPostResourceBundlesSchemaError(error)) {
    throw error;
  }

  return (data as BundleStatusRow | null) ?? null;
}

function buildStoredBundleForQualityCheck(row: BundleStatusRow): PostResourceBundleInput {
  return {
    accessMode: row.access_mode,
    summary: row.summary ?? null,
    previewText: row.preview_text ?? null,
    priceUsdCents: row.price_usd_cents ?? null,
    resources: {
      promptText: row.prompt_text ?? null,
      notesMarkdown: row.notes_markdown ?? null,
      workflowShareUrl: row.workflow_share_url ?? null,
      workflowSnapshot: row.workflow_snapshot ?? null,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      allowRemix: row.allow_remix === true,
      sections: Array.isArray(row.resource_sections) ? row.resource_sections : [],
      items: Array.isArray(row.resource_items) ? row.resource_items : [],
    } as NonNullable<PostResourceBundleInput['resources']>,
  };
}

async function loadOwnedPostMedia(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<ExistingPostMediaRow[]> {
  const BASE_COLUMNS = 'id, storage_path, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order';
  const PREVIEW_COLUMNS = 'preview_storage_path, preview_thumbhash, preview_status, preview_attempt_count, preview_error, preview_generated_at';
  const RENDITION_COLUMNS = 'rendition_storage_path, rendition_status, rendition_attempt_count, rendition_error, rendition_generated_at, rendition_bytes';
  const TEASER_COLUMNS = 'teaser_storage_path, teaser_bytes, teaser_generated_at, teaser_error';

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

  const previewResult = await selectOwnedMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}, ${RENDITION_COLUMNS}, ${TEASER_COLUMNS}`);
  let data = previewResult.data as ExistingPostMediaRow[] | null;
  let error = previewResult.error;

  if (isMissingColumn(error, /teaser_(storage_path|bytes|generated_at|error)/)) {
    const withoutTeaser = await selectOwnedMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}, ${RENDITION_COLUMNS}`);
    data = withoutTeaser.data as ExistingPostMediaRow[] | null;
    error = withoutTeaser.error;
  }

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
  const existingMediaKeys = new Set(existingRows.map((row) => (
    normalizePostMediaKey(row.media_key) ?? defaultPostMediaKey(row.sort_order)
  )));
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
    // A stable key identifies the proof that resource scopes were authored
    // against. Reusing a removed row's key for a different upload would make
    // those scopes silently point at different content.
    if (existingMediaKeys.has(mediaKey)) {
      return { items: null, error: 'New uploads must use a new post media key.' };
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
    const reportedDurationSeconds = typeof descriptor.durationSeconds === 'number'
      && Number.isFinite(descriptor.durationSeconds)
      && descriptor.durationSeconds >= 0
      ? descriptor.durationSeconds
      : null;

    // Advisory: client-reported, so this only catches honest clients early.
    // The rendition sweep's probe of the actual file demotes anything that
    // lied to poster-only in the feed.
    if (mediaKind === 'video' && reportedDurationSeconds !== null
      && reportedDurationSeconds > POST_VIDEO_MAX_DURATION_SECONDS) {
      return { items: null, error: POST_VIDEO_DURATION_LIMIT_MESSAGE };
    }

    const filePath = storagePath.slice(`${UPLOADS_BUCKET}/`.length);
    submitted.push({
      source: 'uploaded',
      mediaKey,
      filePath,
      temporaryStoragePath: filePath,
      originalName,
      contentType,
      mediaKind,
      durationSeconds: reportedDurationSeconds,
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

type PreparedEditedPostMedia = {
  mediaItems: PostMediaPersistInput[];
  newStoragePaths: string[];
  removedStoragePaths: string[];
  temporaryStoragePaths: string[];
};

async function rollbackPreparedEditedPostMedia(
  adminSupabase: SupabaseClient,
  prepared: PreparedEditedPostMedia,
): Promise<void> {
  if (prepared.newStoragePaths.length === 0) {
    return;
  }

  try {
    const cleanup = await adminSupabase.storage
      .from(SHOWCASE_MEDIA_BUCKET)
      .remove(prepared.newStoragePaths);
    if (cleanup.error) {
      logBackendWarning('failed_to_rollback_prepared_post_media', { error: cleanup.error });
    }
  } catch (error) {
    logBackendWarning('failed_to_rollback_prepared_post_media', { error });
  }
}

async function finalizePreparedEditedPostMedia(
  adminSupabase: SupabaseClient,
  prepared: PreparedEditedPostMedia,
  bundleId: string | null = null,
): Promise<void> {
  if (prepared.temporaryStoragePaths.length > 0) {
    try {
      const temporaryCleanup = await adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .remove(prepared.temporaryStoragePaths);
      if (temporaryCleanup.error) {
        logBackendWarning('failed_to_remove_temporary_post_media_after_edit', { error: temporaryCleanup.error });
      }

      // Only what storage confirmed deleted is marked cleared; the rest stays
      // consumed-but-uncleared so the reclaim sweep retries it.
      const removal = getConfirmedRemovedPaths(prepared.temporaryStoragePaths, temporaryCleanup);
      if (removal.confirmed.length > 0) {
        await markMediaUploadIntentsConsumed(adminSupabase, {
          storagePaths: removal.confirmed,
          consumedBy: 'post_update',
          storageCleared: true,
        });
      }
      if (removal.unconfirmed.length > 0) {
        if (!temporaryCleanup.error) {
          logBackendWarning('partially_removed_temporary_post_media_after_edit', {
            requested: prepared.temporaryStoragePaths.length,
            removed: removal.confirmed.length,
          });
        }
        await markMediaUploadIntentsConsumed(adminSupabase, {
          storagePaths: removal.unconfirmed,
          consumedBy: 'post_update',
          storageCleared: false,
        });
      }
    } catch (error) {
      // Database state is already committed. Cleanup is deliberately retryable
      // rather than turning a successful edit into a misleading failure.
      logBackendWarning('failed_to_finalize_temporary_post_media_after_edit', { error });
    }
  }

  if (prepared.removedStoragePaths.length > 0) {
    try {
      const removableStoragePaths = await excludePurchasedProofMediaPaths(
        adminSupabase,
        prepared.removedStoragePaths,
        { bundleId },
      );
      if (removableStoragePaths.length === 0) {
        return;
      }
      const removedMediaCleanup = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .remove(removableStoragePaths);
      if (removedMediaCleanup.error) {
        logBackendWarning('failed_to_remove_deleted_post_media', { error: removedMediaCleanup.error });
      }
    } catch (error) {
      logBackendWarning('failed_to_remove_deleted_post_media', { error });
    }
  }
}

async function prepareEditedPostMedia(params: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  submittedMediaItems: SubmittedEditMediaItem[];
  createPostMediaPreview: typeof createPostMediaPreview;
}): Promise<{
  prepared: PreparedEditedPostMedia | null;
  error: PostUpdateRouteResult | null;
}> {
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
          // force a needless re-encode. The teaser rides for the same reason.
          renditionStoragePath: item.row.rendition_storage_path ?? null,
          renditionStatus: item.row.rendition_status
            ?? (item.row.media_kind === 'video' ? 'pending' : 'skipped'),
          renditionAttemptCount: item.row.rendition_attempt_count ?? 0,
          renditionError: item.row.rendition_error ?? null,
          renditionGeneratedAt: item.row.rendition_generated_at ?? null,
          renditionBytes: item.row.rendition_bytes ?? null,
          teaserStoragePath: item.row.teaser_storage_path ?? null,
          teaserBytes: item.row.teaser_bytes ?? null,
          teaserGeneratedAt: item.row.teaser_generated_at ?? null,
          teaserError: item.row.teaser_error ?? null,
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

      // Same shape as the create path in post-publish-service.ts: the staged
      // object moves between buckets server-side, so an edit that swaps in a
      // 250 MB video no longer pulls those bytes through this function.
      //
      // The size check reads storage metadata and fails closed. The signed
      // upload could only validate a client-declared size, so without an
      // authoritative check here an oversized object reaches the public bucket
      // through edit even though create would have rejected it -- the uploads
      // bucket's own ceiling is 250 MB for every media kind.
      const info = await params.adminSupabase.storage.from(UPLOADS_BUCKET).info(item.filePath);
      const storedSize = (info.data as { size?: unknown } | null | undefined)?.size;
      if (info.error || typeof storedSize !== 'number') {
        throw info.error ?? new Error('Uploaded media metadata was unavailable.');
      }

      const infoContentType = (info.data as { contentType?: unknown } | null | undefined)?.contentType;
      const resolvedContentType = item.contentType
        || (typeof infoContentType === 'string' ? infoContentType : '')
        || null;
      const maxBytes = getMaxUploadBytesForContentType(resolvedContentType);
      if (maxBytes !== null && storedSize > maxBytes) {
        throw new PostMediaTooLargeError(
          `${item.originalName || 'That file'} is larger than the ${formatUploadByteLimit(maxBytes)} limit for this media type.`,
        );
      }

      const extension = inferExtension(item.originalName, item.contentType);
      const storagePath = `posts/${params.postId}/${randomUUID()}/${sanitizeFileStem(item.originalName)}.${extension}`;
      // Both registered before the copy: the staged object is confirmed to
      // exist, and a copy that materializes its destination then fails to
      // answer would otherwise leak an object no cleanup knows about. Removing
      // a path that was never written is a no-op.
      temporaryStoragePaths.push(item.temporaryStoragePath);
      newStoragePaths.push(storagePath);

      const copyResult = await params.adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .copy(item.filePath, storagePath, { destinationBucket: SHOWCASE_MEDIA_BUCKET });
      if (copyResult.error) {
        throw copyResult.error;
      }

      // Video work is deferred to the repair sweep, kicked right after the
      // response. Images keep an inline preview: the thumbhash placeholder is
      // what renders first, and an image is capped at 25 MB.
      let preview: Awaited<ReturnType<typeof createPostMediaPreview>> = null;
      if (item.mediaKind === 'image') {
        try {
          const downloadedMedia = await params.adminSupabase.storage
            .from(UPLOADS_BUCKET)
            .download(item.filePath);
          if (downloadedMedia.error || !downloadedMedia.data) {
            throw downloadedMedia.error ?? new Error('Failed to load uploaded media.');
          }

          preview = await params.createPostMediaPreview({
            body: downloadedMedia.data,
            contentType: resolvedContentType || downloadedMedia.data.type,
            storagePath,
            supabase: params.adminSupabase,
          });
          if (preview?.previewStoragePath) {
            newStoragePaths.push(preview.previewStoragePath);
          }
        } catch (previewError) {
          logBackendWarning('failed_to_create_edited_post_media_preview', { error: previewError });
        }
      }

      persistedMediaItems.push({
        mediaKey: item.mediaKey,
        storagePath,
        // Omitted rather than marked failed when there is nothing to record:
        // replace_post_media defaults these to pending with zero attempts, the
        // state the repair sweep acts on. Writing `failed`/1 here would spend
        // one of three attempts on work that was never tried.
        ...(preview
          ? {
            previewStoragePath: preview.previewStoragePath,
            previewThumbhash: preview.previewThumbhash,
            previewStatus: preview.previewStatus,
            previewAttemptCount: 1,
            previewError: null,
            previewGeneratedAt: new Date().toISOString(),
          }
          : {}),
        externalUrl: null,
        mediaKind: item.mediaKind,
        contentType: resolvedContentType,
        originalName: item.originalName,
        width: preview?.width ?? null,
        height: preview?.height ?? null,
        // Client-reported seed; the rendition sweep's probe overwrites it.
        durationSeconds: item.mediaKind === 'video' ? item.durationSeconds ?? null : null,
        sortOrder: index,
      });
    }

    const retainedStoragePaths = new Set(
      persistedMediaItems
        .flatMap((item) => [item.storagePath, item.previewStoragePath, item.renditionStoragePath, item.teaserStoragePath])
        .filter((storagePath): storagePath is string => Boolean(storagePath)),
    );
    // Renditions and teasers belong on both sides: a dropped video's feed
    // objects are their own public URLs, and skipping them left the exact URL
    // the feed had been serving fetchable forever -- the same gap takedown
    // revocation had.
    const removedStoragePaths = existingMediaRows
      .flatMap((row) => [row.storage_path, row.preview_storage_path, row.rendition_storage_path, row.teaser_storage_path])
      .filter((storagePath): storagePath is string =>
        Boolean(storagePath) && !retainedStoragePaths.has(storagePath as string),
      );

    return {
      prepared: {
        mediaItems: persistedMediaItems,
        newStoragePaths,
        removedStoragePaths,
        temporaryStoragePaths,
      },
      error: null,
    };
  } catch (mediaError) {
    if (newStoragePaths.length > 0) {
      await params.adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove(newStoragePaths);
    }

    // A rejected upload is the caller's problem to fix, not a server fault, so
    // it neither logs as an error nor collapses into the generic 500.
    if (mediaError instanceof PostMediaTooLargeError) {
      return {
        prepared: null,
        error: { ok: false, status: 400, body: { error: mediaError.message } },
      };
    }

    logBackendError('failed_to_update_post_media', { error: mediaError });
    return {
      prepared: null,
      error: { ok: false, status: 500, body: { error: 'Failed to update post media.' } },
    };
  }
}

function isSoldResourceBundleMutationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.message, candidate.details, candidate.hint].some((value) => (
    typeof value === 'string' && /RESOURCE_BUNDLE_LOCKED|already been purchased/i.test(value)
  ));
}

function createSoldResourceBundleLockedResult(): PostUpdateRouteResult {
  return {
    ok: false,
    status: 409,
    body: {
      error: 'People have already purchased this package, so its contents, price, and access mode are locked.',
      code: 'RESOURCE_BUNDLE_LOCKED',
    },
  };
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

    // What someone paid for cannot be rewritten, repriced, or relabelled -- and
    // an `accessMode: 'none'` payload would retire the listing outright. Both
    // composers already omit the bundle for a sold post, so only a stale client
    // or a direct API call reaches this; omitting it keeps every other edit
    // (visibility, caption, media) working.
    if (
      hasResourceBundlePayload
      && existingBundle
      && existingBundle.access_mode === 'paid'
      && (existingBundle.sales_count ?? 0) > 0
    ) {
      return createSoldResourceBundleLockedResult();
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
      existingBundle.status === 'draft' &&
      // A sold bundle's content is frozen by the database. Its status may still
      // follow the post between private and public without resubmitting (and
      // therefore attempting to rewrite) the package payload.
      (existingBundle.sales_count ?? 0) === 0
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
    // Grandfathered: the cap applies only when this request actually changes the
    // title. Both composers PATCH the whole draft rather than a sparse patch, so
    // without the equality check a post written before the limit existed would
    // become unsavable — its author could not fix a typo in the description
    // without first rewriting a title that was legal when they wrote it.
    if (nextTitle && nextTitle !== post.title && nextTitle.length > TITLE_MAX_LENGTH) {
      return {
        ok: false,
        status: 400,
        body: { error: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`, field: 'title' },
      };
    }
    const nextDescription = Object.prototype.hasOwnProperty.call(body, 'description')
      ? normalizeText(body.description)
      : post.description;
    const frozenSoldBundleForRepublish = nextVisibility === 'public'
      && !hasResourceBundlePayload
      && existingBundle
      && (existingBundle.sales_count ?? 0) > 0
      ? buildStoredBundleForQualityCheck(existingBundle)
      : null;
    const bundleForPublicValidation = hasResourceBundlePayload
      ? resourceBundle
      : frozenSoldBundleForRepublish;
    const safetyViolation = nextVisibility !== 'private'
      ? getPublicUgcSafetyViolation({
          title: nextTitle,
          description: nextDescription,
          body: nextBody,
          prompt: post.prompt,
          resourcePrompt: bundleForPublicValidation?.resources?.promptText ?? null,
          resourceNotes: bundleForPublicValidation?.resources?.notesMarkdown ?? null,
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
          bundle: bundleForPublicValidation,
        })
      : null;

    if (marketplaceQualityError) {
      return {
        ok: false,
        status: isCreatorProfileCheckError(marketplaceQualityError) ? 500 : 400,
        body: { error: marketplaceQualityError },
      };
    }

    let preparedMedia: PreparedEditedPostMedia | null = null;
    if (submittedMediaItems) {
      const preparedResult = await prepareEditedPostMedia({
        adminSupabase,
        ownerUserId,
        postId,
        submittedMediaItems,
        createPostMediaPreview: resolvedDependencies.createPostMediaPreview,
      });
      if (preparedResult.error) {
        return preparedResult.error;
      }
      preparedMedia = preparedResult.prepared;
    }

    let updatedPost: Awaited<ReturnType<typeof updatePostWithResourceBundleAtomically>>;
    try {
      updatedPost = await resolvedDependencies.updatePostWithResourceBundleAtomically({
        supabase: adminSupabase,
        postId,
        ownerUserId,
        patch: updatePayload,
        hasBundlePayload: hasResourceBundlePayload,
        bundle: resourceBundle,
        ...(preparedMedia ? { mediaItems: preparedMedia.mediaItems } : {}),
      });
      didMutate = true;
    } catch (error) {
      if (preparedMedia) {
        await rollbackPreparedEditedPostMedia(adminSupabase, preparedMedia);
      }
      throw error;
    }

    if (preparedMedia) {
      await finalizePreparedEditedPostMedia(adminSupabase, preparedMedia, existingBundle?.id ?? null);
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
    if (isSoldResourceBundleMutationError(error)) {
      return createSoldResourceBundleLockedResult();
    }
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
