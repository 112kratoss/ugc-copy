import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingPostsSchemaError } from '@/lib/posts-server';
import { resolvePostRowsToFeedItems as defaultResolvePostRowsToFeedItems } from '@/lib/showcase-feed';
import type {
  ShowcaseFeedItem,
  ShowcaseFeedPage,
} from '@/lib/showcase';

export const DEFAULT_SAVED_MEDIA_LIMIT = 24;
export const MAX_SAVED_MEDIA_LIMIT = 48;

type SavedMediaReference = {
  id: string;
  savedAt: string;
  source: 'post' | 'generation';
};

export type SavedMediaRouteResult =
  | {
      ok: true;
      body: ShowcaseFeedPage;
    }
  | {
      ok: false;
      status: 500;
      body: {
        error: string;
      };
    };

type GetSavedMediaFeedParams = {
  createAdminSupabase: () => SupabaseClient;
  limit: number;
  offset: number;
  resolvePostRowsToFeedItems?: typeof defaultResolvePostRowsToFeedItems;
  userId: string;
  userSupabase: SupabaseClient;
};

function emptySavedMediaPage(limit: number, offset: number): ShowcaseFeedPage {
  return {
    items: [],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit,
      offset,
    },
  };
}

export async function getSavedMediaFeedForRoute({
  createAdminSupabase,
  limit,
  offset,
  resolvePostRowsToFeedItems = defaultResolvePostRowsToFeedItems,
  userId,
  userSupabase,
}: GetSavedMediaFeedParams): Promise<SavedMediaRouteResult> {
  const rangeEnd = offset + limit - 1;

  let savedReferences: SavedMediaReference[] = [];
  let saveSource: SavedMediaReference['source'] = 'post';
  const { data: postSaveData, error: postSaveError } = await userSupabase
    .from('post_saves')
    .select('post_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, rangeEnd);

  if (postSaveError && !isMissingPostsSchemaError(postSaveError)) {
    console.error('Error fetching post saved media:', postSaveError);
    return { ok: false, status: 500, body: { error: 'Failed to fetch saved media' } };
  }

  if (!postSaveError) {
    savedReferences = ((postSaveData ?? []) as Array<{ post_id: string; created_at: string }>)
      .map((row) => ({
        id: row.post_id,
        savedAt: row.created_at,
        source: 'post' as const,
      }));
  }

  if (postSaveError || savedReferences.length === 0) {
    const { data: legacyData, error: legacyError } = await userSupabase
      .from('showcase_saves')
      .select('generation_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, rangeEnd);

    if (legacyError && postSaveError) {
      console.error('Error fetching legacy showcase saved media:', legacyError);
      return { ok: false, status: 500, body: { error: 'Failed to fetch saved media' } };
    }

    if (!legacyError && legacyData?.length) {
      saveSource = 'generation';
      savedReferences = ((legacyData ?? []) as Array<{ generation_id: string; created_at: string }>)
        .map((row) => ({
          id: row.generation_id,
          savedAt: row.created_at,
          source: 'generation' as const,
        }));
    }
  }

  if (savedReferences.length === 0) {
    return {
      ok: true,
      body: emptySavedMediaPage(limit, offset),
    };
  }

  const savedAtMap = new Map<string, string>();
  for (const reference of savedReferences) {
    if (!savedAtMap.has(reference.id)) {
      savedAtMap.set(reference.id, reference.savedAt);
    }
  }

  const lookupIds = Array.from(savedAtMap.keys());
  const countTable = saveSource === 'post' ? 'post_saves' : 'showcase_saves';
  const countColumn = saveSource === 'post' ? 'post_id' : 'generation_id';

  const { count: totalSaveCount, error: countError } = await userSupabase
    .from(countTable)
    .select(countColumn, { count: 'exact', head: true })
    .eq('user_id', userId);

  let hasMore = offset + savedReferences.length < (totalSaveCount ?? 0);
  if (countError) {
    hasMore = savedReferences.length >= limit;
  }

  const { data: postRows, error: postError } = await userSupabase
    .from('posts')
    .select(
      'id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id, visibility'
    )
    .in(saveSource === 'post' ? 'id' : 'generation_id', lookupIds)
    .in('visibility', ['public', 'unlisted']);

  if (postError) {
    console.error('Error fetching saved post rows:', postError);
    return { ok: false, status: 500, body: { error: 'Failed to fetch saved media' } };
  }

  const adminSupabase = createAdminSupabase();
  const hydratedItems = await resolvePostRowsToFeedItems(
    (postRows ?? []) as Parameters<typeof resolvePostRowsToFeedItems>[0],
    adminSupabase
  );

  const hydratedMap = new Map<string, ShowcaseFeedItem>();
  for (const item of hydratedItems) {
    hydratedMap.set(saveSource === 'post' ? item.id : (item.generationId ?? item.id), item);
  }

  const orderedItems: ShowcaseFeedItem[] = [];
  for (const lookupId of lookupIds) {
    const item = hydratedMap.get(lookupId);
    if (item) {
      orderedItems.push({
        ...item,
        isSaved: true,
        savedAt: savedAtMap.get(lookupId),
      });
    }
  }

  return {
    ok: true,
    body: {
      items: orderedItems,
      pageInfo: {
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
        limit,
        offset,
      },
    },
  };
}
