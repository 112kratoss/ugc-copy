import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import {
  getMarketplaceResourceList,
  type MarketplaceResourceListItem,
} from '@/lib/post-resource-bundles-server';
import {
  emptyPublicSearchPage,
  encodePublicSearchCursor,
  type CreatorSearchResult,
  type PublicSearchCursor,
  type PublicSearchResponse,
  type PublicSearchType,
  type RecipeSearchResult,
} from '@/lib/public-search';
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
};

type PublicSearchServiceDependencies = {
  createServiceClient?: typeof createServiceClient;
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  getShowcaseFeedItemsByPostIds?: typeof getShowcaseFeedItemsByPostIds;
  loadBlockedCreatorIds?: typeof loadBlockedCreatorIds;
};

export type PublicSearchOptions = {
  query: string;
  normalizedQuery: string;
  type: PublicSearchType;
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
  const { data, error } = await adminSupabase.rpc('search_public_posts', {
    p_query: query,
    p_viewer_user_id: viewerUserId,
    p_after_score: after?.score ?? null,
    p_after_id: after?.id ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as PostSearchRpcRow[];
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
  const contentQueryAllowed = options.normalizedQuery.length >= 3;
  const creatorTake = isTop ? 5 : options.limit + 1;
  const postTake = isTop ? 12 : options.limit + 1;
  const recipeTake = isTop ? 6 : options.limit + 1;

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
      limit: postTake,
      query: options.normalizedQuery,
      viewerUserId: options.viewerUserId,
    })
    : Promise.resolve([] as PostSearchRpcRow[]);
  const recipesPromise = contentQueryAllowed && (options.type === 'top' || options.type === 'recipes')
    ? dependencies.getMarketplaceResourceList({
      q: options.normalizedQuery,
      offset: options.type === 'recipes' ? options.cursor?.offset ?? 0 : 0,
      limit: recipeTake,
      countryCode: options.countryCode,
    })
    : Promise.resolve({
      items: [] as MarketplaceResourceListItem[],
      pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: recipeTake },
    });

  const [creatorRows, postRows, recipePage] = await Promise.all([
    creatorsPromise,
    postsPromise,
    recipesPromise,
  ]);
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
  const postCursorRow = postHasMore ? postRows[options.limit - 1] : null;

  const recipeHasMore = !isTop && recipePage.items.length > options.limit;
  const visibleRecipes = recipePage.items
    .slice(0, isTop ? recipeTake : options.limit)
    .filter((item) => !blockedIds.has(item.seller.id))
    .map(recipeResult);
  const recipeOffset = options.type === 'recipes' ? options.cursor?.offset ?? 0 : 0;

  return {
    query: options.query,
    normalizedQuery: options.normalizedQuery,
    type: options.type,
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
        items: hydratedPosts,
        nextCursor: postCursorRow
          ? encodePublicSearchCursor({
            version: 1,
            type: 'posts',
            score: postCursorRow.search_score,
            id: postCursorRow.post_id,
          })
          : null,
      }
      : emptyPublicSearchPage(),
    recipes: options.type === 'top' || options.type === 'recipes'
      ? {
        items: visibleRecipes,
        nextCursor: recipeHasMore
          ? encodePublicSearchCursor({
            version: 1,
            type: 'recipes',
            offset: recipeOffset + options.limit,
          })
          : null,
      }
      : emptyPublicSearchPage(),
  };
}
