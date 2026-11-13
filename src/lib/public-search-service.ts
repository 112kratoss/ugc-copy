import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent } from '@/lib/backend-logger';
import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import {
  getMarketplaceResourceList,
  type MarketplaceResourceListItem,
} from '@/lib/post-resource-bundles-server';
import {
  NO_PUBLIC_SEARCH_APPLIED_FILTERS,
  NO_PUBLIC_SEARCH_FILTERS,
  PUBLIC_SEARCH_ENTITY_LIMIT,
  PUBLIC_SEARCH_MAX_RECIPE_OFFSET,
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  appliedPublicSearchSort,
  emptyPublicSearchPage,
  encodePublicSearchCursor,
  publicSearchCursorFilterMark,
  publicSearchQueryLength,
  publicSearchTypeHasFilters,
  type CreatorSearchResult,
  type PublicSearchAppliedFilters,
  type PublicSearchCursor,
  type PublicSearchFilters,
  type PublicSearchResponse,
  type PublicSearchSort,
  type PublicSearchType,
  type RecipeSearchResult,
  type SearchEntityResult,
} from '@/lib/public-search';
import { searchEntityLabel } from '@/lib/search-entity-label';
import { createServiceClient } from '@/lib/server-helpers';
import { getShowcaseFeedItemsByPostIds } from '@/lib/showcase-feed';

type CreatorSearchRpcRow = {
  creator_user_id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  public_post_count: number;
  is_following: boolean;
  search_score: number;
};

type PostSearchRpcRow = {
  post_id: string;
  creator_user_id: string;
  search_score: number;
  /** As the database wrote it, microseconds kept: a Latest cursor carries it back unchanged. */
  created_at: string;
  /**
   * The query as the spelling correction read it, on every row; null when it
   * was read as typed. Absent from a database before 20261112174210.
   */
  corrected_query?: string | null;
};

export type EntitySearchRpcRow = {
  kind: 'model' | 'tool';
  key: string;
  label: string;
  post_count: number;
  post_count_capped: boolean;
};

type PublicSearchServiceDependencies = {
  createServiceClient?: typeof createServiceClient;
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  getShowcaseFeedItemsByPostIds?: typeof getShowcaseFeedItemsByPostIds;
  loadBlockedCreatorIds?: typeof loadBlockedCreatorIds;
  /** Where a failed read of the recipes' reading is noted. */
  logEvent?: typeof logBackendEvent;
  /** The clock a new search's instant is read from. */
  now?: () => Date;
};

export type PublicSearchOptions = {
  query: string;
  normalizedQuery: string;
  type: PublicSearchType;
  /**
   * The order asked for; `top` when left out. Only a Posts or Recipes search
   * is read in it (appliedPublicSearchSort): the Top tab is the best of each
   * kind, and creators have one order.
   */
  sort?: PublicSearchSort;
  /**
   * What narrows a Posts search; none when left out. The caller sends the
   * applied ones (appliedPublicSearchFilters): no `following` for a viewer
   * with no registered account. Only a Posts search is read with them.
   */
  filters?: PublicSearchFilters;
  /** Read the query as typed: no spelling correction, for posts or recipes. */
  exact?: boolean;
  cursor: PublicSearchCursor | null;
  limit: number;
  viewerUserId: string | null;
  countryCode: string | null;
};

function resolveDependencies(dependencies?: PublicSearchServiceDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getMarketplaceResourceList: dependencies?.getMarketplaceResourceList ?? getMarketplaceResourceList,
    getShowcaseFeedItemsByPostIds:
      dependencies?.getShowcaseFeedItemsByPostIds ?? getShowcaseFeedItemsByPostIds,
    loadBlockedCreatorIds: dependencies?.loadBlockedCreatorIds ?? loadBlockedCreatorIds,
    logEvent: dependencies?.logEvent ?? logBackendEvent,
    now: dependencies?.now ?? (() => new Date()),
  };
}

function creatorResult(row: CreatorSearchRpcRow): CreatorSearchResult {
  return {
    id: row.creator_user_id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    publicPostCount: Math.max(0, row.public_post_count ?? 0),
    isFollowing: Boolean(row.is_following),
  };
}

/**
 * An entity as an answer names it. A model made here is named as posts name
 * it (searchEntityLabel), whatever name the database first saw it
 * under: a creation stored without a Made with row is known there by its
 * key alone.
 */
export function entityResult(row: EntitySearchRpcRow): SearchEntityResult {
  return {
    kind: row.kind,
    key: row.key,
    label: searchEntityLabel(row),
    postCount: Math.max(0, row.post_count ?? 0),
    postCountCapped: Boolean(row.post_count_capped),
  };
}

function recipeResult(item: MarketplaceResourceListItem): RecipeSearchResult {
  return {
    id: item.id,
    postId: item.postId,
    title: item.title,
    summary: item.summary,
    previewText: item.previewText,
    accessMode: item.accessMode,
    priceUsdCents: item.priceUsdCents,
    salesCount: item.salesCount,
    freeUnlockCount: item.freeUnlockCount,
    allowRemix: item.allowRemix,
    resourceKinds: item.resourceKinds,
    createdAt: item.createdAt,
    seller: item.seller,
    post: item.post
      ? {
        id: item.post.id,
        title: item.post.title,
        body: item.post.body,
        mediaUrl: item.post.mediaUrl,
        mediaPreviewUrl: item.post.mediaPreviewUrl,
        mediaKind: item.post.mediaKind,
      }
      : null,
    priceQuote: item.priceQuote,
  };
}

async function searchCreators({
  adminSupabase,
  after,
  limit,
  query,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  after: PublicSearchCursor | null;
  limit: number;
  query: string;
  viewerUserId: string | null;
}) {
  const { data, error } = await adminSupabase.rpc('search_public_creators', {
    p_query: query,
    p_viewer_user_id: viewerUserId,
    p_after_score: after?.score ?? null,
    p_after_id: after?.id ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as CreatorSearchRpcRow[];
}

async function searchPosts({
  adminSupabase,
  after,
  asOf,
  exact,
  filters,
  limit,
  query,
  sort,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  after: PublicSearchCursor | null;
  /** The instant a Top search is scored at: the same for every page of it. */
  asOf: Date;
  /** Read the query as typed. */
  exact: boolean;
  filters: PublicSearchFilters;
  limit: number;
  query: string;
  sort: PublicSearchSort;
  viewerUserId: string | null;
}) {
  const { data, error } = await adminSupabase.rpc('search_public_posts', {
    p_query: query,
    p_viewer_user_id: viewerUserId,
    p_after_score: after?.score ?? null,
    p_after_id: after?.id ?? null,
    p_limit: limit,
    p_as_of: asOf.toISOString(),
    p_sort: sort,
    p_after_created_at: after?.createdAt ?? null,
    p_made_with: filters.madeWith,
    p_media_kind: filters.mediaKind,
    p_has_recipe: filters.hasRecipe,
    p_followed_only: filters.following,
    p_correct: !exact,
  });
  if (error) throw error;
  return (data ?? []) as PostSearchRpcRow[];
}

/**
 * The models and tools a search offers (search_public_entities, the one
 * source of which exist and how many posts each has for this viewer): those a
 * post the viewer may see names as the query does, or the one a made-with
 * filter names. A read that fails offers none, with a line in the log: the
 * entities are an extra beside the creators, posts and recipes, and a Posts
 * search narrowed to one is still that search without the name on its chip.
 */
async function searchEntities({
  adminSupabase,
  limit,
  logEvent,
  madeWith,
  query,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  limit: number;
  logEvent: typeof logBackendEvent;
  /** An entity id: that entity alone, whatever the query. */
  madeWith?: string;
  query: string | null;
  viewerUserId: string | null;
}): Promise<SearchEntityResult[]> {
  try {
    const { data, error } = await adminSupabase.rpc('search_public_entities', {
      p_query: query,
      p_viewer_user_id: viewerUserId,
      p_limit: limit,
      p_made_with: madeWith ?? null,
    });
    if (error) throw error;
    return ((data ?? []) as EntitySearchRpcRow[]).map(entityResult);
  } catch (error) {
    logEvent('warn', 'public_search_entities_failed', { error });
    return [];
  }
}

/**
 * How the recipes list reads the query (search_recipes_corrected_query): the
 * corrected reading it will search on, or null when it reads it as typed. A
 * read that fails is `unknown`, with a line in the log: the caller decides
 * what a search may still show without knowing.
 */
type RecipesReading = { known: true; readAs: string | null } | { known: false };

async function recipesCorrectedQuery({
  adminSupabase,
  logEvent,
  query,
}: {
  adminSupabase: SupabaseClient;
  logEvent: typeof logBackendEvent;
  query: string;
}): Promise<RecipesReading> {
  try {
    const { data, error } = await adminSupabase.rpc('search_recipes_corrected_query', { p_query: query });
    if (error) throw error;
    return { known: true, readAs: typeof data === 'string' && data ? data : null };
  } catch (error) {
    logEvent('warn', 'public_search_recipes_reading_failed', { error });
    return { known: false };
  }
}

/** The filters as an answer states them: the made-with entity by its name. */
function appliedFilters(filters: PublicSearchFilters, madeWithEntity: SearchEntityResult | null): PublicSearchAppliedFilters {
  const separator = filters.madeWith?.indexOf(':') ?? -1;
  return {
    madeWith: filters.madeWith && separator > 0
      ? {
        kind: filters.madeWith.slice(0, separator) as SearchEntityResult['kind'],
        key: filters.madeWith.slice(separator + 1),
        // No post this viewer may see has the entity: it is named by its key,
        // never by a name read from somewhere they cannot see.
        label: madeWithEntity?.label ?? filters.madeWith.slice(separator + 1),
      }
      : null,
    mediaKind: filters.mediaKind,
    hasRecipe: filters.hasRecipe,
    following: filters.following,
  };
}

async function blockedCreatorIds({
  adminSupabase,
  creatorIds,
  loadBlockedCreatorIds: loadBlocked,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  creatorIds: string[];
  loadBlockedCreatorIds: typeof loadBlockedCreatorIds;
  viewerUserId: string | null;
}) {
  if (!viewerUserId || creatorIds.length === 0) return new Set<string>();
  return loadBlocked({
    adminSupabase,
    creatorIds,
    viewerUserId,
  });
}

export async function searchPublicContent(
  options: PublicSearchOptions,
  dependencyOverrides?: PublicSearchServiceDependencies,
): Promise<PublicSearchResponse> {
  const dependencies = resolveDependencies(dependencyOverrides);
  const adminSupabase = dependencies.createServiceClient();
  const isTop = options.type === 'top';
  const sort = appliedPublicSearchSort(options.type, options.sort ?? 'top');
  // Only a Posts search is narrowed: the Top tab is the best of each kind.
  const filters = publicSearchTypeHasFilters(options.type)
    ? options.filters ?? NO_PUBLIC_SEARCH_FILTERS
    : NO_PUBLIC_SEARCH_FILTERS;
  const exact = options.exact ?? false;
  // A Top posts search is scored at the instant it began, which its cursor
  // carries from page to page: the score depends on the clock, and a page
  // scored later than the one before it could repeat or skip a post. A cursor
  // issued before 2026-11-12 carries none, so its page is scored now and the
  // cursor after it carries that.
  const postsAsOf = options.type === 'posts' && options.cursor?.asOf !== undefined
    ? new Date(options.cursor.asOf)
    : dependencies.now();
  const contentQueryAllowed = publicSearchQueryLength(options.normalizedQuery) >= PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH;
  const creatorTake = isTop ? 5 : options.limit + 1;
  const postTake = isTop ? 12 : options.limit + 1;
  // The marketplace list already reads one row past the page to learn whether
  // there is more, so it is asked for the page itself.
  const recipeTake = isTop ? 6 : options.limit;

  const creatorsPromise = options.type === 'top' || options.type === 'creators'
    ? searchCreators({
      adminSupabase,
      after: options.type === 'creators' ? options.cursor : null,
      limit: creatorTake,
      query: options.normalizedQuery,
      viewerUserId: options.viewerUserId,
    })
    : Promise.resolve([] as CreatorSearchRpcRow[]);
  const postsPromise = contentQueryAllowed && (options.type === 'top' || options.type === 'posts')
    ? searchPosts({
      adminSupabase,
      after: options.type === 'posts' ? options.cursor : null,
      asOf: postsAsOf,
      exact,
      filters,
      limit: postTake,
      query: options.normalizedQuery,
      sort,
      viewerUserId: options.viewerUserId,
    })
    : Promise.resolve([] as PostSearchRpcRow[]);
  // The Top tab offers the models and tools the query names, from the three
  // characters posts are searched from: pressing one opens Posts narrowed to
  // it, and under three there is no Posts search to open. A Posts search
  // narrowed to one reads that one, for the name its filter is shown under.
  const entitiesPromise = isTop && contentQueryAllowed
    ? searchEntities({
      adminSupabase,
      limit: PUBLIC_SEARCH_ENTITY_LIMIT,
      logEvent: dependencies.logEvent,
      query: options.normalizedQuery,
      viewerUserId: options.viewerUserId,
    })
    : filters.madeWith
      ? searchEntities({
        adminSupabase,
        limit: 1,
        logEvent: dependencies.logEvent,
        madeWith: filters.madeWith,
        query: null,
        viewerUserId: options.viewerUserId,
      })
      : Promise.resolve([] as SearchEntityResult[]);
  const recipesSearched = contentQueryAllowed && (options.type === 'top' || options.type === 'recipes');
  const emptyRecipePage = {
    items: [] as MarketplaceResourceListItem[],
    pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: recipeTake },
  };
  const listRecipes = () => dependencies.getMarketplaceResourceList({
    q: options.normalizedQuery,
    // The best matches first, as posts and creators are ordered; Latest
    // is the list's own newest-first order.
    sort: sort === 'latest' ? 'recent' : 'relevance',
    offset: options.type === 'recipes' ? options.cursor?.offset ?? 0 : 0,
    limit: recipeTake,
    countryCode: options.countryCode,
  });
  const recipesReadingPromise: Promise<RecipesReading> = recipesSearched
    ? recipesCorrectedQuery({ adminSupabase, logEvent: dependencies.logEvent, query: options.normalizedQuery })
    : Promise.resolve({ known: true, readAs: null });
  // The list corrects a query only when no recipe holds it as typed, so read
  // as typed such a search is the empty list: it is answered without the
  // call, which would search on the corrected words. When the reading cannot
  // be read the list is not called either: it might correct, under a page
  // that says "as typed". Recipes are left out of that one answer.
  const recipesPromise = !recipesSearched
    ? Promise.resolve(emptyRecipePage)
    : exact
      ? recipesReadingPromise.then((reading) => (
        reading.known && reading.readAs === null ? listRecipes() : emptyRecipePage
      ))
      : listRecipes();

  const [creatorRows, postRows, recipePage, entities, recipesReading] = await Promise.all([
    creatorsPromise,
    postsPromise,
    recipesPromise,
    entitiesPromise,
    recipesReadingPromise,
  ]);
  // search_public_creators and search_public_posts leave both sides of a block
  // out before their limit, by the two reads loadBlockedCreatorIds makes, so a
  // page of creators or posts is short only when the results are. This pass
  // stays for what they cannot cover: a block made between the ranked read and
  // this line, and recipes, whose list takes no viewer; a blocked seller's
  // recipe is dropped here, after the cut, and that page comes back short
  // while its cursor still reaches the rest.
  const blockedIds = await blockedCreatorIds({
    adminSupabase,
    creatorIds: [
      ...creatorRows.map((row) => row.creator_user_id),
      ...postRows.map((row) => row.creator_user_id),
      ...recipePage.items.map((item) => item.seller.id),
    ],
    loadBlockedCreatorIds: dependencies.loadBlockedCreatorIds,
    viewerUserId: options.viewerUserId,
  });

  const creatorHasMore = !isTop && creatorRows.length > options.limit;
  const visibleCreatorRows = creatorRows
    .slice(0, isTop ? creatorTake : options.limit)
    .filter((row) => !blockedIds.has(row.creator_user_id));
  const creatorCursorRow = creatorHasMore ? creatorRows[options.limit - 1] : null;

  const postHasMore = !isTop && postRows.length > options.limit;
  const visiblePostRows = postRows
    .slice(0, isTop ? postTake : options.limit)
    .filter((row) => !blockedIds.has(row.creator_user_id));
  const hydratedPosts = visiblePostRows.length > 0
    ? await dependencies.getShowcaseFeedItemsByPostIds({
      postIds: visiblePostRows.map((row) => row.post_id),
      viewerUserId: options.viewerUserId,
      countryCode: options.countryCode,
    })
    : [];
  // search_public_posts already leaves NSFW-labelled posts out before its
  // limit, which keeps pages full. Hydration covers a labelled post rather
  // than dropping it, so a post labelled after the ranked read would still
  // come back as a "Mature content" card matched on its hidden words. Explore
  // drops such a post after hydration, and so does search.
  const shownPosts = hydratedPosts.filter((item) => !item.isNsfw);
  const postCursorRow = postHasMore ? postRows[options.limit - 1] : null;

  // The list pages in raw rows and drops the ones it cannot show (a hidden
  // post, a failed quality check), so only its
  // own nextOffset says where the next page starts. Counting returned items
  // repeated a row after a drop, or ended the list early after two.
  // A next page past the cursor's cap would be refused as invalid: the list
  // ends there, as the marketplace's own route ends it.
  const recipeNextOffset = !isTop && recipePage.pageInfo.hasMore
    && recipePage.pageInfo.nextOffset !== null
    && recipePage.pageInfo.nextOffset <= PUBLIC_SEARCH_MAX_RECIPE_OFFSET
    ? recipePage.pageInfo.nextOffset
    : null;
  const visibleRecipes = recipePage.items
    .filter((item) => !blockedIds.has(item.seller.id))
    .map(recipeResult);

  // A posts cursor pages the filters and the reading it was issued under.
  const postCursorFilters = publicSearchCursorFilterMark(filters, exact);

  return {
    query: options.query,
    normalizedQuery: options.normalizedQuery,
    type: options.type,
    sort,
    entities: isTop ? entities : [],
    filters: publicSearchTypeHasFilters(options.type)
      ? appliedFilters(filters, entities[0] ?? null)
      : NO_PUBLIC_SEARCH_APPLIED_FILTERS,
    // Said only beside results it explains: a corrected search that shows no
    // post, or no recipe, has nothing to show results "for".
    correctedQuery: {
      posts: !exact && shownPosts.length > 0 ? postRows[0]?.corrected_query ?? null : null,
      // A reading that could not be read says nothing: the recipes stand without the notice.
      recipes: !exact && visibleRecipes.length > 0 && recipesReading.known ? recipesReading.readAs : null,
    },
    exact,
    creators: options.type === 'top' || options.type === 'creators'
      ? {
        items: visibleCreatorRows.map(creatorResult),
        nextCursor: creatorCursorRow
          ? encodePublicSearchCursor({
            version: 1,
            type: 'creators',
            score: creatorCursorRow.search_score,
            id: creatorCursorRow.creator_user_id,
          })
          : null,
      }
      : emptyPublicSearchPage(),
    posts: options.type === 'top' || options.type === 'posts'
      ? {
        items: shownPosts,
        nextCursor: postCursorRow
          ? encodePublicSearchCursor({
            version: 1,
            type: 'posts',
            id: postCursorRow.post_id,
            ...(sort === 'latest'
              ? { sort, createdAt: postCursorRow.created_at }
              : { score: postCursorRow.search_score, asOf: postsAsOf.getTime() }),
            ...(postCursorFilters ? { filters: postCursorFilters } : {}),
          })
          : null,
      }
      : emptyPublicSearchPage(),
    recipes: options.type === 'top' || options.type === 'recipes'
      ? {
        items: visibleRecipes,
        nextCursor: recipeNextOffset !== null
          ? encodePublicSearchCursor({
            version: 1,
            type: 'recipes',
            ...(sort === 'latest' ? { sort } : {}),
            offset: recipeNextOffset,
          })
          : null,
      }
      : emptyPublicSearchPage(),
  };
}
