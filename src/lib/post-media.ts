import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveStoredMediaUrl } from '@/lib/server-helpers';
import { getPostMediaKind, resolvePostMediaUrl, type PostMediaRow as LegacyPostMediaRow } from '@/lib/posts-server';
import type { ShowcaseMediaKind, ShowcasePostFormat, ShowcaseItemCategory } from '@/lib/showcase';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

export const MAX_POST_MEDIA_ITEMS = 5;

export interface PostMediaSummary {
  id: string;
  url: string;
  mediaKind: ShowcaseMediaKind;
  contentType: string | null;
  originalName: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sortOrder: number;
}

export interface PostMediaPersistInput {
  storagePath: string | null;
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
  storage_path: string | null;
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

        return {
          id: row.id,
          url,
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

  const { data, error } = await supabase
    .from('post_media')
    .select('id, post_id, storage_path, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order')
    .in('post_id', uniquePostIds)
    .order('sort_order', { ascending: true });

  if (error) {
    if (isMissingPostMediaSchemaError(error)) {
      return new Map();
    }

    throw error;
  }

  const rowsByPostId = new Map<string, PostMediaDbRow[]>();
  for (const row of (data ?? []) as PostMediaDbRow[]) {
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

  return [{
    id: `${params.postId}:cover`,
    url,
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

  const { error } = await params.supabase
    .from('post_media')
    .insert(params.mediaItems.map((item) => ({
      post_id: params.postId,
      storage_path: item.storagePath,
      external_url: item.externalUrl ?? null,
      media_kind: item.mediaKind,
      content_type: item.contentType,
      original_name: item.originalName,
      width: item.width ?? null,
      height: item.height ?? null,
      duration_seconds: item.durationSeconds ?? null,
      sort_order: item.sortOrder,
    })));

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
