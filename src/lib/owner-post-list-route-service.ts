import {
  getOwnerPostList,
  type OwnerPostListItem,
  type OwnerPostVisibilityFilter,
} from '@/lib/owner-posts';

export type LoadOwnerPosts = (
  userId: string,
  options: {
    includeArchived: boolean;
    visibility: OwnerPostVisibilityFilter;
  }
) => Promise<OwnerPostListItem[] | unknown[]>;

export type OwnerPostListRouteResult =
  | {
      ok: true;
      posts: Awaited<ReturnType<LoadOwnerPosts>>;
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

export async function listOwnerPostsForRoute({
  userId,
  searchParams,
  loadOwnerPosts = getOwnerPostList,
}: {
  userId: string;
  searchParams: URLSearchParams;
  loadOwnerPosts?: LoadOwnerPosts;
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
  const posts = await loadOwnerPosts(userId, {
    includeArchived,
    visibility,
  });

  return {
    ok: true,
    posts,
  };
}
