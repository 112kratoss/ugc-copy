import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_COMMENT_CREATE_RATE_LIMIT,
  POST_COMMENT_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked, loadBlockedCreatorIds } from '@/lib/moderation-service';
import { getCreatorDisplayName } from '@/lib/profile';

export const POST_COMMENT_PAGE_SIZE = 20;
export const POST_COMMENT_MAX_PAGE_SIZE = 50;
export const POST_COMMENT_MAX_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type PostCommentSort = 'top' | 'newest';

export type PostCommentStatus =
  | 'active'
  | 'removed_by_author'
  | 'removed_by_owner'
  | 'removed_by_moderation';

export type PostCommentAuthor = {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type PostCommentItem = {
  id: string;
  parentId: string | null;
  body: string;
  status: PostCommentStatus;
  createdAt: string;
  replyCount: number;
  author: PostCommentAuthor | null;
};

export type PostCommentsPage = {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  comments: PostCommentItem[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
};

type CommentRow = {
  id: string;
  post_id: string;
  user_id: string | null;
  parent_comment_id: string | null;
  body: string;
  status: PostCommentStatus;
  reply_count: number;
  created_at: string;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type PostReference = {
  id: string;
  user_id: string | null;
  comment_count: number;
};

export type PostCommentsRouteResult<TBody> =
  | { ok: true; status: 200 | 201; body: TBody }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

export function normalizePostCommentSort(value: unknown): PostCommentSort {
  return value === 'newest' ? 'newest' : 'top';
}

export function normalizePostCommentLimit(value: unknown) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return POST_COMMENT_PAGE_SIZE;
  return Math.min(Math.trunc(parsed), POST_COMMENT_MAX_PAGE_SIZE);
}

export function normalizePostCommentOffset(value: unknown) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

export function normalizePostCommentBody(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > POST_COMMENT_MAX_LENGTH) return null;
  return trimmed;
}

export function normalizePostCommentId(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeOptionalId(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? normalizePostCommentId(value)
    : null;
}

function createRateLimitResult<TBody>(
  error: BackendRateLimitError,
): PostCommentsRouteResult<TBody> {
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

async function findCommentablePost(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<{ post: PostReference | null; error: unknown | null }> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select('id, user_id, comment_count')
    .eq('id', postId)
    .eq('visibility', 'public')
    .is('archived_at', null)
    .eq('review_status', 'visible')
    .maybeSingle();

  if (error) return { post: null, error };
  return { post: data ? data as PostReference : null, error: null };
}

async function loadCommentAuthors(
  adminSupabase: SupabaseClient,
  userIds: Array<string | null>,
): Promise<Map<string, ProfileRow>> {
  const uniqueIds = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (!uniqueIds.length) return new Map();

  const { data, error } = await adminSupabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', uniqueIds);

  if (error) {
    logBackendError('failed_to_load_post_comment_authors', { error });
    return new Map();
  }

  return new Map((data ?? []).map((row) => [String(row.id), row as ProfileRow]));
}

/**
 * A removed comment keeps its row so replies underneath it survive, but its
 * body and author never leave the server — clients render it as "[deleted]".
 */
export function toPostCommentItem(
  row: CommentRow,
  profiles: Map<string, ProfileRow>,
): PostCommentItem {
  const removed = row.status !== 'active' || !row.user_id;
  const profile = removed || !row.user_id ? undefined : profiles.get(row.user_id);

  return {
    id: row.id,
    parentId: row.parent_comment_id ?? null,
    body: removed ? '' : row.body,
    status: row.status,
    createdAt: row.created_at,
    replyCount: Math.max(0, row.reply_count ?? 0),
    author: removed
      ? null
      : {
          id: row.user_id as string,
          username: profile?.username ?? null,
          displayName: getCreatorDisplayName({
            displayName: profile?.display_name ?? null,
            username: profile?.username ?? null,
          }),
          avatarUrl: profile?.avatar_url ?? null,
        },
  };
}

export async function listPostCommentsForRoute({
  postId,
  viewerUserId,
  parentId,
  sort = 'top',
  limit = POST_COMMENT_PAGE_SIZE,
  offset = 0,
  createAdminSupabase,
}: {
  postId: string;
  viewerUserId: string | null;
  parentId?: string | null;
  sort?: PostCommentSort;
  limit?: number;
  offset?: number;
  createAdminSupabase: () => SupabaseClient;
}): Promise<PostCommentsRouteResult<PostCommentsPage>> {
  const normalizedPostId = normalizePostCommentId(postId);
  if (!normalizedPostId) {
    return { ok: false, status: 400, body: { error: 'Choose a valid post.' } };
  }

  const normalizedParentId = normalizeOptionalId(parentId);
  if (
    typeof parentId === 'string'
    && parentId.trim()
    && !normalizedParentId
  ) {
    return { ok: false, status: 400, body: { error: 'Choose a valid parent comment.' } };
  }

  const adminSupabase = createAdminSupabase();
  const postResult = await findCommentablePost(adminSupabase, normalizedPostId);

  if (postResult.error) {
    logBackendError('failed_to_load_commentable_post', { error: postResult.error });
    return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
  }

  const post = postResult.post;
  if (!post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  const buildQuery = () => {
    let query = adminSupabase
      .from('post_comments')
      .select('id, post_id, user_id, parent_comment_id, body, status, reply_count, created_at')
      .eq('post_id', normalizedPostId);

    if (normalizedParentId) {
      query = query
        .eq('parent_comment_id', normalizedParentId)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
    } else {
      // Removed top-level comments stay in the thread only while they still hold
      // replies, so the conversation underneath them does not disappear.
      query = query.is('parent_comment_id', null).or('status.eq.active,reply_count.gt.0');

      if (sort === 'top') {
        query = query.order('reply_count', { ascending: false });
      }

      query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    }

    return query;
  };

  // Paging is based on visible comments, not raw rows. Otherwise a page made
  // entirely of blocked authors can strand later safe comments behind an empty
  // result. nextOffset remains the raw database offset so existing clients stay
  // compatible.
  const visibleRows: CommentRow[] = [];
  const scanBatchSize = Math.max(limit + 1, POST_COMMENT_PAGE_SIZE);
  let scanOffset = offset;
  let hasMore = false;
  let nextOffset: number | null = null;

  scan: while (true) {
    const { data, error } = await buildQuery().range(
      scanOffset,
      scanOffset + scanBatchSize - 1,
    );

    if (error) {
      logBackendError('failed_to_list_post_comments', { error });
      return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
    }

    const rows = (data ?? []) as CommentRow[];
    let blockedIds = new Set<string>();
    if (viewerUserId && rows.length > 0) {
      try {
        blockedIds = await loadBlockedCreatorIds({
          adminSupabase,
          creatorIds: rows
            .map((row) => row.user_id)
            .filter((id): id is string => Boolean(id)),
          viewerUserId,
        });
      } catch (blockError) {
        logBackendError('failed_to_filter_blocked_post_comments', { error: blockError });
        return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const isBlocked = row.status === 'active'
        && Boolean(row.user_id && blockedIds.has(row.user_id));
      if (isBlocked) continue;

      if (visibleRows.length === limit) {
        hasMore = true;
        nextOffset = scanOffset + index;
        break scan;
      }
      visibleRows.push(row);
    }

    if (rows.length < scanBatchSize) break;
    scanOffset += rows.length;
  }

  const profiles = await loadCommentAuthors(
    adminSupabase,
    visibleRows.map((row) => row.user_id),
  );

  return {
    ok: true,
    status: 200,
    body: {
      postId: post.id,
      postCreatorId: post.user_id ?? null,
      commentCount: Math.max(0, post.comment_count ?? 0),
      comments: visibleRows.map((row) => toPostCommentItem(row, profiles)),
      pageInfo: {
        hasMore,
        nextOffset,
        limit,
        offset,
      },
    },
  };
}

export async function createPostCommentForRoute({
  postId,
  authorUserId,
  readBody,
  createAdminSupabase,
  checkRelationshipBlocked = isUserRelationshipBlocked,
}: {
  postId: string;
  authorUserId: string;
  readBody: () => Promise<unknown>;
  createAdminSupabase: () => SupabaseClient;
  checkRelationshipBlocked?: typeof isUserRelationshipBlocked;
}): Promise<
  PostCommentsRouteResult<{ success: true; comment: PostCommentItem; commentCount: number }>
> {
  const normalizedPostId = normalizePostCommentId(postId);
  if (!normalizedPostId) {
    return { ok: false, status: 400, body: { error: 'Choose a valid post.' } };
  }

  let raw: unknown;
  try {
    raw = await readBody();
  } catch {
    return { ok: false, status: 400, body: { error: 'Request body must be valid JSON.' } };
  }
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { body?: unknown; parentId?: unknown })
    : {};

  const body = normalizePostCommentBody(payload.body);
  if (!body) {
    return { ok: false, status: 400, body: { error: 'Write a comment before posting.' } };
  }

  const parentId = normalizeOptionalId(payload.parentId);
  if (
    payload.parentId !== undefined
    && payload.parentId !== null
    && payload.parentId !== ''
    && !parentId
  ) {
    return { ok: false, status: 400, body: { error: 'Choose a valid parent comment.' } };
  }
  const adminSupabase = createAdminSupabase();

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_COMMENT_CREATE_RATE_LIMIT,
      key: authorUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('post_comment_rate_limit_check_failed', { error });
    return { ok: false, status: 500, body: { error: 'Failed to check comment limits.' } };
  }

  const postResult = await findCommentablePost(adminSupabase, normalizedPostId);
  if (postResult.error) {
    logBackendError('failed_to_load_commentable_post', { error: postResult.error });
    return { ok: false, status: 500, body: { error: 'Failed to post comment.' } };
  }

  const post = postResult.post;
  if (!post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  if (await isCommentInteractionBlocked({
    actorUserId: authorUserId,
    counterpartUserId: post.user_id,
    adminSupabase,
    checkRelationshipBlocked,
  })) {
    return { ok: false, status: 403, body: { error: 'Commenting is unavailable on this post.' } };
  }

  if (parentId) {
    const { data: parent, error: parentError } = await adminSupabase
      .from('post_comments')
      .select('id, user_id, post_id, parent_comment_id, status')
      .eq('id', parentId)
      .eq('post_id', normalizedPostId)
      .maybeSingle();

    if (parentError) {
      logBackendError('failed_to_load_parent_post_comment', { error: parentError });
      return { ok: false, status: 500, body: { error: 'Failed to post comment.' } };
    }

    if (!parent || parent.status !== 'active') {
      return { ok: false, status: 404, body: { error: 'That comment is no longer available.' } };
    }

    if (parent.parent_comment_id) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Replies can only target top-level comments.' },
      };
    }

    if (await isCommentInteractionBlocked({
      actorUserId: authorUserId,
      counterpartUserId: parent.user_id ? String(parent.user_id) : null,
      adminSupabase,
      checkRelationshipBlocked,
    })) {
      return { ok: false, status: 403, body: { error: 'Replying is unavailable on this comment.' } };
    }
  }

  const { data, error } = await adminSupabase.rpc('create_post_comment', {
    p_post_id: normalizedPostId,
    p_user_id: authorUserId,
    p_parent_comment_id: parentId,
    p_body: body,
  });

  if (error) {
    logBackendError('failed_to_create_post_comment', { error });
    return { ok: false, status: 500, body: { error: 'Failed to post comment.' } };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    return { ok: false, status: 500, body: { error: 'Failed to post comment.' } };
  }

  const created = row as {
    comment_id: string;
    created_at: string;
    comment_count: number;
    parent_reply_count: number;
  };

  const profiles = await loadCommentAuthors(adminSupabase, [authorUserId]);

  return {
    ok: true,
    status: 201,
    body: {
      success: true,
      commentCount: Math.max(0, created.comment_count ?? 0),
      comment: toPostCommentItem(
        {
          id: created.comment_id,
          post_id: normalizedPostId,
          user_id: authorUserId,
          parent_comment_id: parentId,
          body,
          status: 'active',
          reply_count: 0,
          created_at: created.created_at,
        },
        profiles,
      ),
    },
  };
}

export async function removePostCommentForRoute({
  postId,
  commentId,
  actorUserId,
  createAdminSupabase,
}: {
  postId: string;
  commentId: string;
  actorUserId: string;
  createAdminSupabase: () => SupabaseClient;
}): Promise<
  PostCommentsRouteResult<{ success: true; status: PostCommentStatus; commentCount: number }>
> {
  const normalizedPostId = normalizePostCommentId(postId);
  const normalizedCommentId = normalizePostCommentId(commentId);
  if (!normalizedPostId || !normalizedCommentId) {
    return { ok: false, status: 400, body: { error: 'Choose a valid comment.' } };
  }

  const adminSupabase = createAdminSupabase();

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_COMMENT_MUTATION_RATE_LIMIT,
      key: actorUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('post_comment_mutation_rate_limit_check_failed', { error });
    return { ok: false, status: 500, body: { error: 'Failed to check comment limits.' } };
  }

  const { data: comment, error: commentError } = await adminSupabase
    .from('post_comments')
    .select('id, post_id, user_id, posts!inner(user_id)')
    .eq('id', normalizedCommentId)
    .eq('post_id', normalizedPostId)
    .maybeSingle();

  if (commentError) {
    logBackendError('failed_to_load_post_comment_for_removal', { error: commentError });
    return { ok: false, status: 500, body: { error: 'Failed to remove comment.' } };
  }

  if (!comment) {
    return { ok: false, status: 404, body: { error: 'Comment not found.' } };
  }

  const relatedPost = comment.posts as unknown as { user_id: string | null } | { user_id: string | null }[];
  const postOwnerId = Array.isArray(relatedPost)
    ? relatedPost[0]?.user_id ?? null
    : relatedPost?.user_id ?? null;

  const nextStatus: PostCommentStatus | null =
    String(comment.user_id) === actorUserId
      ? 'removed_by_author'
      : postOwnerId && String(postOwnerId) === actorUserId
        ? 'removed_by_owner'
        : null;

  if (!nextStatus) {
    return { ok: false, status: 403, body: { error: 'You cannot remove this comment.' } };
  }

  const { data, error } = await adminSupabase.rpc('set_post_comment_status', {
    p_comment_id: normalizedCommentId,
    p_actor_user_id: actorUserId,
    p_next_status: nextStatus,
  });

  if (error) {
    logBackendError('failed_to_remove_post_comment', { error });
    return { ok: false, status: 500, body: { error: 'Failed to remove comment.' } };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { changed: boolean; comment_count: number }
    | null;

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      status: nextStatus,
      commentCount: Math.max(0, row?.comment_count ?? 0),
    },
  };
}

async function isCommentInteractionBlocked({
  actorUserId,
  counterpartUserId,
  adminSupabase,
  checkRelationshipBlocked,
}: {
  actorUserId: string;
  counterpartUserId: string | null | undefined;
  adminSupabase: SupabaseClient;
  checkRelationshipBlocked: typeof isUserRelationshipBlocked;
}) {
  if (!counterpartUserId || counterpartUserId === actorUserId) return false;

  try {
    return await checkRelationshipBlocked({
      adminSupabase,
      firstUserId: actorUserId,
      secondUserId: counterpartUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_before_commenting', { error });
    return true;
  }
}
