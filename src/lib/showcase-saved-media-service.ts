import { decodeMediaLibraryCursor, encodeMediaLibraryCursor, mediaLibraryBoundaryFilter } from '@/lib/media-library-cursor';
import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingPostsSchemaError } from '@/lib/posts-server';
import {
  attachLocalizedAssetPrices,
  attachViewerStateToFeed,
  resolvePostRowsToFeedItems as defaultResolvePostRowsToFeedItems,
} from '@/lib/showcase-feed';
import {
  sanitizeShowcaseFeedPage,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
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
      status: 400 | 500;
      body: {
        error: string;
      };
    };

type GetSavedMediaFeedParams = {
  createAdminSupabase: () => SupabaseClient;
  /** The viewer's country, which recipe prices are quoted in, as on the feed. */
  countryCode?: string | null;
  limit: number;
  offset: number;
  pagination?: string;
  cursor?: string | null;
  resolvePostRowsToFeedItems?: typeof defaultResolvePostRowsToFeedItems;
  userId: string;
  userSupabase: SupabaseClient;
};

function emptySavedMediaPage(limit: number, offset: number, cursorMode = false): ShowcaseFeedPage {
  return {
    items: [],
    pageInfo: {
      hasMore: false,
      ...(cursorMode ? { nextCursor: null } : {}),
      nextOffset: null,
      limit,
      offset,
    },
  };
}

export async function getSavedMediaFeedForRoute({
  createAdminSupabase,
  countryCode = null,
  limit,
  offset,
  pagination,
  cursor,
  resolvePostRowsToFeedItems = defaultResolvePostRowsToFeedItems,
  userId,
  userSupabase,
}: GetSavedMediaFeedParams): Promise<SavedMediaRouteResult> {
  const cursorMode = pagination === 'cursor' || cursor != null;
  const postScope = `saved:${userId}:post`;
  const legacyScope = `saved:${userId}:generation`;
  const postBoundary = cursor ? decodeMediaLibraryCursor(cursor, postScope) : null;
  const legacyBoundary = cursor ? decodeMediaLibraryCursor(cursor, legacyScope) : null;
  if ((cursor != null && !postBoundary && !legacyBoundary) || (cursorMode && offset !== 0)) {
    return { ok: false, status: 400, body: { error: 'Invalid media cursor.' } };
  }
  const rangeEnd = offset + limit - (cursorMode ? 0 : 1);
  let savedReferences: SavedMediaReference[] = [];
  let saveSource: SavedMediaReference['source'] = 'post';
  let postQuery = userSupabase.from('post_saves').select('post_id, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false });
  if (cursorMode) postQuery = postQuery.order('post_id', { ascending: true });
  if (postBoundary) postQuery = postQuery.lte('created_at', postBoundary.createdAt).or(mediaLibraryBoundaryFilter(postBoundary, 'post_id', true));
  const { data: postSaveData, error: postSaveError } = legacyBoundary
    ? { data: null, error: null }
    : await postQuery.range(offset, rangeEnd);

  if (postSaveError && (postBoundary || !isMissingPostsSchemaError(postSaveError))) {
    logBackendError('error_fetching_post_saved_media', { error: postSaveError });
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

  if (legacyBoundary || (!postBoundary && (postSaveError || savedReferences.length === 0))) {
    let legacyQuery = userSupabase
      .from('showcase_saves')
      .select('generation_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (cursorMode) legacyQuery = legacyQuery.order('generation_id', { ascending: true });
    if (legacyBoundary) legacyQuery = legacyQuery.lte('created_at', legacyBoundary.createdAt).or(mediaLibraryBoundaryFilter(legacyBoundary, 'generation_id', true));
    const { data: legacyData, error: legacyError } = await legacyQuery.range(offset, rangeEnd);

    if (legacyError && (postSaveError || legacyBoundary)) {
      logBackendError('error_fetching_legacy_showcase_saved_media', { error: legacyError });
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
      body: emptySavedMediaPage(limit, offset, cursorMode),
    };
  }

  const cursorHasMore = savedReferences.length > limit;
  if (cursorMode) savedReferences = savedReferences.slice(0, limit);
  const lastReference = savedReferences.at(-1)!;
  const savedAtMap = new Map<string, string>();
  for (const reference of savedReferences) {
    if (!savedAtMap.has(reference.id)) {
      savedAtMap.set(reference.id, reference.savedAt);
    }
  }

  const lookupIds = Array.from(savedAtMap.keys());
  const countTable = saveSource === 'post' ? 'post_saves' : 'showcase_saves';
  const countColumn = saveSource === 'post' ? 'post_id' : 'generation_id';

  const { count: totalSaveCount, error: countError } = cursorMode
    ? { count: null, error: null }
    : await userSupabase
    .from(countTable)
    .select(countColumn, { count: 'exact', head: true })
    .eq('user_id', userId);

  let hasMore = cursorMode ? cursorHasMore : offset + savedReferences.length < (totalSaveCount ?? 0);
  if (countError) {
    hasMore = savedReferences.length >= limit;
  }

  const adminSupabase = createAdminSupabase();
  const { data: postRows, error: postError } = await adminSupabase
    .from('posts')
    .select(
      'id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id, visibility'
    )
    .in(saveSource === 'post' ? 'id' : 'generation_id', lookupIds)
    .in('visibility', ['public', 'unlisted'])
    .eq('review_status', 'visible')
    .is('archived_at', null);

  if (postError) {
    logBackendError('error_fetching_saved_post_rows', { error: postError });
    return { ok: false, status: 500, body: { error: 'Failed to fetch saved media' } };
  }

  const hydratedItems = await resolvePostRowsToFeedItems(
    (postRows ?? []) as Parameters<typeof resolvePostRowsToFeedItems>[0],
    adminSupabase
  );
  // Hydration carries each recipe's full locked preview (item titles, cards,
  // file names and sizes). A saved post goes out the way the feed's reads by
  // id send it to this viewer: priced in their currency, with the recipes and
  // Remix they own, without a creator either of them blocked (none at all if
  // that cannot be read), and redacted to the public teaser.
  const pricedFeed = await attachLocalizedAssetPrices(
    { items: hydratedItems, pageInfo: { hasMore: false, nextOffset: null, limit, offset } },
    countryCode,
  );
  const viewerSafeItems = sanitizeShowcaseFeedPage(
    await attachViewerStateToFeed(pricedFeed, userId, adminSupabase),
  ).items;

  const hydratedMap = new Map<string, ShowcaseFeedItem>();
  for (const item of viewerSafeItems) {
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
        ...(cursorMode ? { nextCursor: hasMore ? encodeMediaLibraryCursor(
          saveSource === 'post' ? postScope : legacyScope,
          { id: lastReference.id, createdAt: lastReference.savedAt },
        ) : null } : {}),
        nextOffset: hasMore ? offset + limit : null,
        limit,
        offset,
      },
    },
  };
}
