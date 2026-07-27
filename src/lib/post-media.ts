import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveStoredMediaUrl } from '@/lib/server-helpers';
import { buildVisualMediaDescriptor, type VisualMediaDescriptor } from '@/lib/media-descriptor';
import type { PostMediaRenditionStatus } from '@/lib/post-media-rendition';
import { defaultPostMediaKey, normalizePostMediaKey } from '@/lib/post-media-key';
import { getPostMediaKind, resolvePostMediaUrl, type PostMediaRow as LegacyPostMediaRow } from '@/lib/posts-server';
import type { ShowcaseMediaKind, ShowcasePostFormat, ShowcaseItemCategory } from '@/lib/showcase';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

export const MAX_POST_MEDIA_ITEMS = 5;

export interface PostMediaSummary {
  id: string;
  mediaKey: string;
  url: string;
  renditionUrl: string | null;
  renditionStatus: PostMediaRenditionStatus;
  previewUrl: string | null;
  previewThumbhash: string | null;
  previewStatus: 'pending' | 'processing' | 'ready' | 'failed';
  previewCacheKey: string;
  gridReady: boolean;
  preview: VisualMediaDescriptor;
  mediaKind: ShowcaseMediaKind;
  contentType: string | null;
  originalName: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sortOrder: number;
}

export interface PostMediaPersistInput {
  mediaKey: string;
  storagePath: string | null;
  previewStoragePath?: string | null;
  previewThumbhash?: string | null;
  previewStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  previewAttemptCount?: number;
  previewError?: string | null;
  previewGeneratedAt?: string | null;
  renditionStoragePath?: string | null;
  renditionStatus?: PostMediaRenditionStatus;
  renditionAttemptCount?: number;
  renditionError?: string | null;
  renditionGeneratedAt?: string | null;
  renditionBytes?: number | null;
  externalUrl?: string | null;
  mediaKind: ShowcaseMediaKind;
  contentType: string | null;
  originalName: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sortOrder: number;
}

interface PostMediaDbRow {
  id: string;
  post_id: string;
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
  media_kind: ShowcaseMediaKind;
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  sort_order: number;
}

type SupabaseSchemaError = {
  code?: string;
  message?: string;
};

function isMissingPostMediaPreviewColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as SupabaseSchemaError;
  return (code === '42703' || code === 'PGRST204') && /preview_(storage_path|thumbhash|status|attempt_count|error|generated_at)/.test(message);
}

function isMissingPostMediaKeyColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as SupabaseSchemaError;
  return (code === '42703' || code === 'PGRST204') && /media_key/.test(message);
}

/**
 * Lets the app boot against a database that has not taken the rendition
 * migration yet — the same degradation the preview columns already rely on.
 */
function isMissingPostMediaRenditionColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as SupabaseSchemaError;
  return (code === '42703' || code === 'PGRST204')
    && /rendition_(storage_path|status|attempt_count|error|generated_at|bytes)/.test(message);
}

export function isMissingPostMediaSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as SupabaseSchemaError;
  return (
    (code === 'PGRST205' && message.includes('public.post_media')) ||
    (code === '42P01' && message.includes('post_media')) ||
    message.includes("Could not find the table 'public.post_media'")
  );
}

export function getMediaKindFromContentType(contentType: string | null | undefined): ShowcaseMediaKind | null {
  if (contentType?.startsWith('image/')) {
    return 'image';
  }

  if (contentType?.startsWith('video/')) {
    return 'video';
  }

  return null;
}

async function resolvePostMediaDbRowUrl(
  supabase: SupabaseClient,
  row: PostMediaDbRow
): Promise<string | null> {
  if (row.storage_path) {
    const { data } = supabase.storage.from(SHOWCASE_MEDIA_BUCKET).getPublicUrl(row.storage_path);
    return data.publicUrl;
  }

  if (!row.external_url) {
    return null;
  }

  if (row.external_url.startsWith('http')) {
    return row.external_url;
  }

  return resolveStoredMediaUrl(supabase, row.external_url);
}

async function resolvePostMediaDbRows(
  supabase: SupabaseClient,
  rows: PostMediaDbRow[]
): Promise<PostMediaSummary[]> {
  const resolved = await Promise.all(
    rows
      .slice()
      .sort((left, right) => left.sort_order - right.sort_order)
      .map(async (row) => {
        const url = await resolvePostMediaDbRowUrl(supabase, row);
        if (!url) {
          return null;
        }

        const previewUrl = row.preview_storage_path
          ? supabase.storage.from(SHOWCASE_MEDIA_BUCKET).getPublicUrl(row.preview_storage_path).data.publicUrl
          : null;
        const previewStatus = row.preview_status ?? (previewUrl ? 'ready' : 'pending');
        // Only a 'ready' row is served: a path left behind by a half-finished
        // attempt must never reach the feed.
        const renditionUrl = row.rendition_storage_path && row.rendition_status === 'ready'
          ? supabase.storage.from(SHOWCASE_MEDIA_BUCKET).getPublicUrl(row.rendition_storage_path).data.publicUrl
          : null;
        const renditionStatus: PostMediaRenditionStatus = row.rendition_status
          ?? (row.media_kind === 'video' ? 'pending' : 'skipped');
        const preview = buildVisualMediaDescriptor({
          id: row.id,
          kind: row.media_kind,
          url,
          storageKey: row.storage_path ?? row.external_url ?? row.id,
          renditionUrl,
          previewUrl,
          previewStorageKey: row.preview_storage_path ?? null,
          previewThumbhash: row.preview_thumbhash ?? null,
          previewStatus,
          expiresAt: null,
          width: row.width,
          height: row.height,
          durationSeconds: row.duration_seconds,
        });
        return {
          id: row.id,
          mediaKey: normalizePostMediaKey(row.media_key) ?? defaultPostMediaKey(row.sort_order),
          url,
          renditionUrl,
          renditionStatus,
          previewUrl,
          previewThumbhash: row.preview_thumbhash ?? null,
          previewStatus,
          previewCacheKey: row.preview_storage_path ?? row.storage_path ?? row.external_url ?? row.id,
          gridReady: preview.gridReady,
          preview,
          mediaKind: row.media_kind,
          contentType: row.content_type,
          originalName: row.original_name,
          width: row.width,
          height: row.height,
          durationSeconds: row.duration_seconds,
          sortOrder: row.sort_order,
        } satisfies PostMediaSummary;
      })
  );

  return resolved.filter((item): item is PostMediaSummary => item !== null);
}

export async function loadPostMediaItemsMap(
  supabase: SupabaseClient,
  postIds: string[]
): Promise<Map<string, PostMediaSummary[]>> {
  const uniquePostIds = Array.from(new Set(postIds.filter(Boolean)));
  if (uniquePostIds.length === 0) {
    return new Map();
  }

  // Widest column set first, then shed one migration's worth of columns per
  // retry so the app keeps serving against an older database.
  const BASE_COLUMNS = 'id, post_id, storage_path, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order';
  const PREVIEW_COLUMNS = 'preview_storage_path, preview_thumbhash, preview_status, preview_attempt_count, preview_error, preview_generated_at';
  const RENDITION_COLUMNS = 'rendition_storage_path, rendition_status, rendition_attempt_count, rendition_error, rendition_generated_at, rendition_bytes';

  const selectPostMedia = (columns: string) => supabase
    .from('post_media')
    .select(columns)
    .in('post_id', uniquePostIds)
    .order('sort_order', { ascending: true });

  const fullResult = await selectPostMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}, ${RENDITION_COLUMNS}`);
  let data = fullResult.data as PostMediaDbRow[] | null;
  let error = fullResult.error;

  if (isMissingPostMediaRenditionColumnError(error)) {
    const withoutRendition = await selectPostMedia(`${BASE_COLUMNS}, media_key, ${PREVIEW_COLUMNS}`);
    data = withoutRendition.data as PostMediaDbRow[] | null;
    error = withoutRendition.error;
  }

  if (isMissingPostMediaKeyColumnError(error)) {
    const keylessPreviewResult = await selectPostMedia(`${BASE_COLUMNS}, ${PREVIEW_COLUMNS}`);
    data = keylessPreviewResult.data as PostMediaDbRow[] | null;
    error = keylessPreviewResult.error;
  }

  if (isMissingPostMediaPreviewColumnError(error)) {
    const legacyResult = await selectPostMedia(BASE_COLUMNS);
    data = legacyResult.data as PostMediaDbRow[] | null;
    error = legacyResult.error;
  }

  if (error) {
    if (isMissingPostMediaSchemaError(error)) {
      return new Map();
    }

    throw error;
  }

  const rowsByPostId = new Map<string, PostMediaDbRow[]>();
  for (const row of data ?? []) {
    const list = rowsByPostId.get(row.post_id) ?? [];
    list.push(row);
    rowsByPostId.set(row.post_id, list);
  }

  const result = new Map<string, PostMediaSummary[]>();
  await Promise.all(
    Array.from(rowsByPostId.entries()).map(async ([postId, rows]) => {
      result.set(postId, await resolvePostMediaDbRows(supabase, rows));
    })
  );

  return result;
}

export async function buildLegacyPostMediaItems(params: {
  supabase: SupabaseClient;
  postId: string;
  row: LegacyPostMediaRow & {
    category: ShowcaseItemCategory;
    post_format: ShowcasePostFormat;
  };
}): Promise<PostMediaSummary[]> {
  const mediaKind = getPostMediaKind(params.row.category, params.row.post_format);
  const url = await resolvePostMediaUrl(params.supabase, params.row);
  if (!mediaKind || !url) {
    return [];
  }

  const preview = buildVisualMediaDescriptor({
    id: `${params.postId}:cover`,
    kind: mediaKind,
    url,
    storageKey: params.row.showcase_asset_path ?? params.row.output_url ?? `${params.postId}:cover`,
    renditionUrl: null,
    previewUrl: null,
    previewStorageKey: null,
    previewThumbhash: null,
    previewStatus: 'pending',
    expiresAt: null,
    width: null,
    height: null,
    durationSeconds: null,
  });
  return [{
    id: `${params.postId}:cover`,
    mediaKey: defaultPostMediaKey(0),
    url,
    // Legacy cover rows predate post_media, so there is no rendition to point at.
    renditionUrl: null,
    renditionStatus: 'skipped',
    previewUrl: null,
    previewThumbhash: null,
    previewStatus: 'pending',
    previewCacheKey: params.row.showcase_asset_path ?? params.row.output_url ?? `${params.postId}:cover`,
    gridReady: false,
    preview,
    mediaKind,
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

export async function insertPostMediaItems(params: {
  supabase: SupabaseClient;
  postId: string;
  mediaItems: PostMediaPersistInput[];
}): Promise<void> {
  if (params.mediaItems.length === 0) {
    return;
  }

  const rows = params.mediaItems.map((item) => ({
      post_id: params.postId,
      media_key: normalizePostMediaKey(item.mediaKey) ?? defaultPostMediaKey(item.sortOrder),
      storage_path: item.storagePath,
      preview_storage_path: item.previewStoragePath ?? null,
      preview_thumbhash: item.previewThumbhash ?? null,
      preview_status: item.previewStatus ?? (item.previewStoragePath ? 'ready' : 'pending'),
      preview_attempt_count: item.previewAttemptCount ?? (item.previewStoragePath ? 1 : 0),
      preview_error: item.previewError ?? null,
      preview_generated_at: item.previewGeneratedAt ?? (item.previewStoragePath ? new Date().toISOString() : null),
      rendition_storage_path: item.renditionStoragePath ?? null,
      rendition_status: item.renditionStatus
        ?? (item.mediaKind === 'video' ? 'pending' : 'skipped'),
      rendition_attempt_count: item.renditionAttemptCount ?? (item.renditionStoragePath ? 1 : 0),
      rendition_error: item.renditionError ?? null,
      rendition_generated_at: item.renditionGeneratedAt ?? (item.renditionStoragePath ? new Date().toISOString() : null),
      rendition_bytes: item.renditionBytes ?? null,
      external_url: item.externalUrl ?? null,
      media_kind: item.mediaKind,
      content_type: item.contentType,
      original_name: item.originalName,
      width: item.width ?? null,
      height: item.height ?? null,
      duration_seconds: item.durationSeconds ?? null,
      sort_order: item.sortOrder,
    }));
  let insertRows: Array<Record<string, unknown>> = rows;
  let { error } = await params.supabase.from('post_media').insert(insertRows);

  for (let fallbackAttempt = 0; error && fallbackAttempt < 3; fallbackAttempt += 1) {
    const removeMediaKey = isMissingPostMediaKeyColumnError(error);
    const removePreviewFields = isMissingPostMediaPreviewColumnError(error);
    const removeRenditionFields = isMissingPostMediaRenditionColumnError(error);
    if (!removeMediaKey && !removePreviewFields && !removeRenditionFields) {
      break;
    }

    insertRows = insertRows.map((row) => {
      const fallbackRow = { ...row };
      if (removeMediaKey) {
        delete fallbackRow.media_key;
      }
      if (removePreviewFields) {
        delete fallbackRow.preview_storage_path;
        delete fallbackRow.preview_thumbhash;
        delete fallbackRow.preview_status;
        delete fallbackRow.preview_attempt_count;
        delete fallbackRow.preview_error;
        delete fallbackRow.preview_generated_at;
      }
      if (removeRenditionFields) {
        delete fallbackRow.rendition_storage_path;
        delete fallbackRow.rendition_status;
        delete fallbackRow.rendition_attempt_count;
        delete fallbackRow.rendition_error;
        delete fallbackRow.rendition_generated_at;
        delete fallbackRow.rendition_bytes;
      }
      return fallbackRow;
    });
    const fallbackResult = await params.supabase.from('post_media').insert(insertRows);
    error = fallbackResult.error;
  }

  if (error) {
    throw error;
  }
}

export async function replacePostMediaItems(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  mediaItems: PostMediaPersistInput[];
}): Promise<void> {
  const { error } = await params.supabase.rpc('replace_post_media', {
    p_post_id: params.postId,
    p_owner_user_id: params.ownerUserId,
    p_media_items: params.mediaItems,
  });

  if (error) {
    throw error;
  }
}
