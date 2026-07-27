import {
  getOwnerPostList,
  type OwnerPostListItem,
  type OwnerPostVisibilityFilter,
} from '@/lib/owner-posts';
import {
  getOwnerPostSalesSummary,
  type OwnerPostSalesSummary,
} from '@/lib/owner-post-sales-summary';

export type LoadOwnerPosts = (
  userId: string,
  options: {
    includeArchived: boolean;
    limit?: number;
    offset?: number;
    visibility: OwnerPostVisibilityFilter;
  }
) => Promise<OwnerPostListItem[] | unknown[]>;

export type LoadOwnerPostSalesSummary = (userId: string) => Promise<OwnerPostSalesSummary>;

export type OwnerPostListRouteResult =
  | {
      ok: true;
      posts: Awaited<ReturnType<LoadOwnerPosts>>;
      pageInfo: {
        hasMore: boolean;
        limit: number;
        nextOffset: number | null;
        offset: number;
      };
      summary?: OwnerPostSalesSummary;
    }
  | {
      ok: false;
      status: 400;
      error: string;
    };

function normalizeOwnerPostVisibilityFilter(value: string | null): OwnerPostVisibilityFilter {
  if (value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived') {
    return value;
  }

  return 'all';
}

function parseBoundedInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.round(parsed), maximum);
}

export async function listOwnerPostsForRoute({
  userId,
  searchParams,
  loadOwnerPosts = getOwnerPostList,
  loadOwnerPostSalesSummary = getOwnerPostSalesSummary,
}: {
  userId: string;
  searchParams: URLSearchParams;
  loadOwnerPosts?: LoadOwnerPosts;
  loadOwnerPostSalesSummary?: LoadOwnerPostSalesSummary;
}): Promise<OwnerPostListRouteResult> {
  const scope = searchParams.get('scope');
  if (scope !== 'owner') {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported posts scope.',
    };
  }

  const visibility = normalizeOwnerPostVisibilityFilter(searchParams.get('visibility'));
  const includeArchived = searchParams.get('includeArchived') === 'true' || visibility === 'archived';
  const limit = Math.max(1, parseBoundedInteger(searchParams.get('limit'), 48, 100));
  const offset = parseBoundedInteger(searchParams.get('offset'), 0, 1_000_000);
  const includeSummary = searchParams.get('includeSummary') === 'true';
  const [loadedPosts, summary] = await Promise.all([
    loadOwnerPosts(userId, {
      includeArchived,
      limit: limit + 1,
      offset,
      visibility,
    }),
    includeSummary ? loadOwnerPostSalesSummary(userId) : Promise.resolve(null),
  ]);
  const posts = loadedPosts.slice(0, limit);
  const hasMore = loadedPosts.length > limit;

  return {
    ok: true,
    posts,
    pageInfo: {
      hasMore,
      limit,
      nextOffset: hasMore ? offset + limit : null,
      offset,
    },
    ...(summary ? { summary } : {}),
  };
}
