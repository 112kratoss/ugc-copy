import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_COMMENT_CREATE_RATE_LIMIT,
  POST_COMMENT_MUTATION_RATE_LIMIT,
  POST_COMMENT_REACTION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  isUserRelationshipBlocked,
  loadBlockedCreatorIds,
  loadViewerBlockRelationships,
} from '@/lib/moderation-service';
import { getCreatorDisplayName } from '@/lib/profile';
import {
  parseFeedDeliveryIdField,
  scheduleAuthoritativeFeedEvent,
} from '@/lib/showcase-feed-events-service';

export const POST_COMMENT_PAGE_SIZE = 20;
export const POST_COMMENT_MAX_PAGE_SIZE = 50;
export const POST_COMMENT_MAX_LENGTH = 2000;
/**
 * F9: the visible-comment scan was `while (true)`.
 *
 * It exits when a page is filled or the table runs out, so on a thread where a
 * viewer has blocked many authors it walked every comment on the post. Ten
 * batches is far more than any real page needs — at the default page size that
 * is 200 raw rows examined for 20 visible ones — and it converts an unbounded
 * walk into a bounded one. Hitting the cap reports `hasMore`, so the client
 * pages on from the last offset examined instead of being told the thread ended.
 */
export const POST_COMMENT_MAX_SCAN_ITERATIONS = 10;
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

export type PostCommentReaction = 'like' | 'dislike';

export type PostCommentItem = {
  id: string;
  parentId: string | null;
  body: string;
  status: PostCommentStatus;
  createdAt: string;
  replyCount: number;
  author: PostCommentAuthor | null;
  /** Likes only: how many readers disliked a comment never leaves the server. */
  likeCount: number;
  /** The reader's own like or dislike; null for a visitor and for none. */
  viewerReaction: PostCommentReaction | null;
  /** When its author last changed its words; null for a comment as first posted. */
  editedAt: string | null;
  /** The post's creator marked it. */
  hearted: boolean;
  /** The post's creator pinned it: the first comment of the thread, in either order. */
  pinned: boolean;
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
  like_count?: number | null;
  edited_at?: string | null;
  hearted_at?: string | null;
  pinned_at?: string | null;
};

/** What a thread read selects of a comment: every column but the count of dislikes. */
const COMMENT_ROW_COLUMNS =
  'id, post_id, user_id, parent_comment_id, body, status, reply_count, created_at, like_count, edited_at, hearted_at, pinned_at';

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
  viewerReactions: ReadonlyMap<string, PostCommentReaction> = new Map(),
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
    // A removed comment is "[deleted]": it shows no likes, heart, pin or edit.
    likeCount: removed ? 0 : Math.max(0, row.like_count ?? 0),
    viewerReaction: removed ? null : viewerReactions.get(row.id) ?? null,
    editedAt: removed ? null : row.edited_at ?? null,
    hearted: !removed && Boolean(row.hearted_at),
    pinned: !removed && Boolean(row.pinned_at),
  };
}

/**
 * The reader's own reactions to the comments about to be answered. A failed
 * read answers none: the thread still loads, with no like shown as pressed.
 */
async function loadViewerReactions(
  adminSupabase: SupabaseClient,
  viewerUserId: string | null,
  commentIds: string[],
): Promise<Map<string, PostCommentReaction>> {
  if (!viewerUserId || !commentIds.length) return new Map();

  const { data, error } = await adminSupabase
    .from('post_comment_reactions')
    .select('comment_id, reaction')
    .eq('user_id', viewerUserId)
    .in('comment_id', commentIds);

  if (error) {
    logBackendError('failed_to_load_post_comment_viewer_reactions', { error });
    return new Map();
  }

  const reactions = new Map<string, PostCommentReaction>();
  for (const row of data ?? []) {
    if (row.reaction === 'like' || row.reaction === 'dislike') {
      reactions.set(String(row.comment_id), row.reaction);
    }
  }
  return reactions;
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
      .select(COMMENT_ROW_COLUMNS)
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
      // The pinned comment is read on its own and leads the first page (below),
      // so it is left out here: every offset then counts the same rows.
      query = query
        .is('parent_comment_id', null)
        .is('pinned_at', null)
        .or('status.eq.active,reply_count.gt.0');

      if (sort === 'top') {
        // The most liked first, then the most replied to
        // (post_comments_toplevel_liked_idx).
        query = query
          .order('like_count', { ascending: false })
          .order('reply_count', { ascending: false });
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
  let reachedEndOfThread = false;

  // F9: loaded once, not once per batch. `loadBlockedCreatorIds` issues two
  // `user_blocks` queries, and calling it inside an uncapped scan meant two
  // queries per iteration with no ceiling. The block set is a property of the
  // viewer, not of the batch, so hoisting it makes the whole scan cost two
  // queries total however many batches it walks.
  let blockedIds = new Set<string>();
  // Tracked explicitly rather than inferred from `blockedIds.size === 0`: an
  // empty set is the *common* case (a viewer who has blocked nobody), and
  // treating it as "fall back" would put the per-batch queries back on the
  // hot path for almost everyone.
  let useExactPerBatchBlockFilter = false;
  if (viewerUserId) {
    try {
      const relationships = await loadViewerBlockRelationships({ adminSupabase, viewerUserId });
      blockedIds = relationships.blockedUserIds;

      // The thread belongs to its post creator, including comments written by
      // other people. Do not expose that thread across either direction of block.
      const creatorBlocked = post.user_id && (
        relationships.truncated
          ? (await loadBlockedCreatorIds({
            adminSupabase, viewerUserId, creatorIds: [post.user_id],
          })).has(post.user_id)
          : blockedIds.has(post.user_id)
      );
      if (creatorBlocked) {
        return { ok: false, status: 404, body: { error: 'Post not found.' } };
      }

      if (relationships.truncated) {
        // Beyond the cap the in-memory set is incomplete, and an incomplete
        // block set shows a viewer content they blocked. Fall back to the
        // per-batch filtered lookup, which is exact at any list size.
        logBackendWarning('post_comment_block_set_truncated', { viewerUserId });
        blockedIds = new Set<string>();
        useExactPerBatchBlockFilter = true;
      }
    } catch (blockError) {
      logBackendError('failed_to_filter_blocked_post_comments', { error: blockError });
      return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
    }
  }

  scan: for (let iteration = 0; iteration < POST_COMMENT_MAX_SCAN_ITERATIONS; iteration += 1) {
    const { data, error } = await buildQuery().range(
      scanOffset,
      scanOffset + scanBatchSize - 1,
    );

    if (error) {
      logBackendError('failed_to_list_post_comments', { error });
      return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
    }

    const rows = (data ?? []) as CommentRow[];

    // Only reached when the viewer's block list exceeded the cap above.
    if (useExactPerBatchBlockFilter && viewerUserId && rows.length > 0) {
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

    if (rows.length < scanBatchSize) {
      reachedEndOfThread = true;
      break;
    }
    scanOffset += rows.length;
  }

  // Neither a full page nor the end of the thread stopped the scan, so the
  // iteration cap did. Reporting `hasMore` here is what keeps the cap a
  // *bound* rather than a silent truncation: the client continues from the
  // last offset examined instead of being told the conversation ended.
  if (!hasMore && !reachedEndOfThread) {
    hasMore = true;
    nextOffset = scanOffset;
    logBackendWarning('post_comment_scan_cap_reached', {
      postId: normalizedPostId,
      scanOffset,
      iterations: POST_COMMENT_MAX_SCAN_ITERATIONS,
    });
  }

  // The post's one pinned comment leads the thread's first page, in either
  // order. It is extra to the page's `limit`, and no offset counts it.
  if (!normalizedParentId && offset === 0) {
    const { data: pinnedRow, error: pinnedError } = await adminSupabase
      .from('post_comments')
      .select(COMMENT_ROW_COLUMNS)
      .eq('post_id', normalizedPostId)
      .is('parent_comment_id', null)
      .eq('status', 'active')
      .not('pinned_at', 'is', null)
      .maybeSingle();

    if (pinnedError) {
      logBackendError('failed_to_load_pinned_post_comment', { error: pinnedError });
      return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
    }

    const pinned = pinnedRow as CommentRow | null;
    if (pinned) {
      let pinnedAuthorBlocked = Boolean(pinned.user_id && blockedIds.has(pinned.user_id));
      if (useExactPerBatchBlockFilter && viewerUserId && pinned.user_id) {
        try {
          pinnedAuthorBlocked = (await loadBlockedCreatorIds({
            adminSupabase, viewerUserId, creatorIds: [pinned.user_id],
          })).has(pinned.user_id);
        } catch (blockError) {
          logBackendError('failed_to_filter_blocked_post_comments', { error: blockError });
          return { ok: false, status: 500, body: { error: 'Failed to load comments.' } };
        }
      }
      if (!pinnedAuthorBlocked) visibleRows.unshift(pinned);
    }
  }

  const [profiles, viewerReactions] = await Promise.all([
    loadCommentAuthors(adminSupabase, visibleRows.map((row) => row.user_id)),
    loadViewerReactions(adminSupabase, viewerUserId, visibleRows.map((row) => row.id)),
  ]);

  return {
    ok: true,
    status: 200,
    body: {
      postId: post.id,
      postCreatorId: post.user_id ?? null,
      commentCount: Math.max(0, post.comment_count ?? 0),
      comments: visibleRows.map((row) => toPostCommentItem(row, profiles, viewerReactions)),
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
  runAfterResponse,
  scheduleFeedEvent = scheduleAuthoritativeFeedEvent,
}: {
  postId: string;
  authorUserId: string;
  readBody: () => Promise<unknown>;
  createAdminSupabase: () => SupabaseClient;
  checkRelationshipBlocked?: typeof isUserRelationshipBlocked;
  /**
   * The route passes one so the comment's feed event is written behind the
   * answer; without it the event is written, bounded by its timeout, first.
   */
  runAfterResponse?: RunAfterResponse;
  scheduleFeedEvent?: typeof scheduleAuthoritativeFeedEvent;
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
    ? (raw as { body?: unknown; parentId?: unknown; deliveryId?: unknown })
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

  // The comment is recorded. Its feed event (v4's `comment` signal, attributed
  // to the feed delivery the client commented from when it sent one) is
  // telemetry: it never fails or holds this answer, and is written once per
  // commenter, post and delivery however many comments follow.
  await scheduleFeedEvent(runAfterResponse, adminSupabase, {
    eventType: 'comment',
    viewerUserId: authorUserId,
    postId: normalizedPostId,
    deliveryId: parseFeedDeliveryIdField(payload.deliveryId),
    occurredAt: created.created_at,
  });

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

export type PostCommentUpdate =
  | { kind: 'edit'; body: string }
  | { kind: 'reaction'; reaction: PostCommentReaction | null }
  | { kind: 'heart'; hearted: boolean }
  | { kind: 'pin'; pinned: boolean };

/**
 * One change per request: the comment's words (its author), the reader's own
 * like or dislike (any account), the heart or the pin (the post's creator).
 * Anything else, and two at once, is refused rather than guessed at.
 */
export function parsePostCommentUpdate(raw: unknown): PostCommentUpdate | { error: string } {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const named = (['body', 'reaction', 'hearted', 'pinned'] as const)
    .filter((key) => payload[key] !== undefined);

  if (named.length !== 1) {
    return { error: 'Send one change: body, reaction, hearted or pinned.' };
  }

  switch (named[0]) {
    case 'body': {
      const body = normalizePostCommentBody(payload.body);
      return body ? { kind: 'edit', body } : { error: 'Write a comment before saving.' };
    }
    case 'reaction': {
      const reaction = payload.reaction;
      if (reaction === null || reaction === 'like' || reaction === 'dislike') {
        return { kind: 'reaction', reaction };
      }
      return { error: 'Choose like, dislike or no reaction.' };
    }
    case 'hearted':
      return typeof payload.hearted === 'boolean'
        ? { kind: 'heart', hearted: payload.hearted }
        : { error: 'Say whether the comment is hearted.' };
    default:
      return typeof payload.pinned === 'boolean'
        ? { kind: 'pin', pinned: payload.pinned }
        : { error: 'Say whether the comment is pinned.' };
  }
}

type UpdatableCommentRow = CommentRow & {
  posts:
    | { user_id: string | null; visibility: string; archived_at: string | null; review_status: string }
    | Array<{ user_id: string | null; visibility: string; archived_at: string | null; review_status: string }>;
};

const UPDATE_FAILURE: Record<PostCommentUpdate['kind'], string> = {
  edit: 'Failed to save comment.',
  reaction: 'Failed to save your reaction.',
  heart: 'Failed to update the heart.',
  pin: 'Failed to update the pin.',
};

/** What each function raises when the comment or its post went away under it. */
const UPDATE_LOST_RACE = /Comment not found|Comment is not available|Post is private or not found/;

export async function updatePostCommentForRoute({
  postId,
  commentId,
  actorUserId,
  readBody,
  createAdminSupabase,
  checkRelationshipBlocked = isUserRelationshipBlocked,
}: {
  postId: string;
  commentId: string;
  actorUserId: string;
  readBody: () => Promise<unknown>;
  createAdminSupabase: () => SupabaseClient;
  checkRelationshipBlocked?: typeof isUserRelationshipBlocked;
}): Promise<
  PostCommentsRouteResult<{
    success: true;
    comment: PostCommentItem;
    /** The comment a new pin took the post's one pin from, if any. */
    unpinnedCommentId: string | null;
  }>
> {
  const normalizedPostId = normalizePostCommentId(postId);
  const normalizedCommentId = normalizePostCommentId(commentId);
  if (!normalizedPostId || !normalizedCommentId) {
    return { ok: false, status: 400, body: { error: 'Choose a valid comment.' } };
  }

  let raw: unknown;
  try {
    raw = await readBody();
  } catch {
    return { ok: false, status: 400, body: { error: 'Request body must be valid JSON.' } };
  }
  const update = parsePostCommentUpdate(raw);
  if ('error' in update) {
    return { ok: false, status: 400, body: { error: update.error } };
  }

  const adminSupabase = createAdminSupabase();
  const failure = UPDATE_FAILURE[update.kind];

  try {
    // A like is pressed far more often than a comment is edited or pinned,
    // and must not spend the budget a delete draws on.
    await enforceBackendRateLimit(adminSupabase, {
      ...(update.kind === 'reaction' ? POST_COMMENT_REACTION_RATE_LIMIT : POST_COMMENT_MUTATION_RATE_LIMIT),
      key: actorUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('post_comment_update_rate_limit_check_failed', { error });
    return { ok: false, status: 500, body: { error: 'Failed to check comment limits.' } };
  }

  const { data: found, error: commentError } = await adminSupabase
    .from('post_comments')
    .select(`${COMMENT_ROW_COLUMNS}, posts!inner(user_id, visibility, archived_at, review_status)`)
    .eq('id', normalizedCommentId)
    .eq('post_id', normalizedPostId)
    .maybeSingle();

  if (commentError) {
    logBackendError('failed_to_load_post_comment_for_update', { error: commentError });
    return { ok: false, status: 500, body: { error: failure } };
  }

  const comment = found as unknown as UpdatableCommentRow | null;
  const post = comment
    ? (Array.isArray(comment.posts) ? comment.posts[0] : comment.posts) ?? null
    : null;
  // The same test a new comment's post must pass: public, live, not taken down.
  const postTakesComments = Boolean(
    post && post.visibility === 'public' && !post.archived_at && post.review_status === 'visible',
  );
  if (!comment || !post || !postTakesComments) {
    return { ok: false, status: 404, body: { error: 'Comment not found.' } };
  }
  if (comment.status !== 'active' || !comment.user_id) {
    return { ok: false, status: 404, body: { error: 'That comment is no longer available.' } };
  }

  const isAuthor = String(comment.user_id) === actorUserId;
  const isPostOwner = Boolean(post.user_id && String(post.user_id) === actorUserId);

  if (update.kind === 'edit' && !isAuthor) {
    return { ok: false, status: 403, body: { error: 'You can only edit your own comment.' } };
  }
  if ((update.kind === 'heart' || update.kind === 'pin') && !isPostOwner) {
    return {
      ok: false,
      status: 403,
      body: {
        error: update.kind === 'heart'
          ? 'Only the post\'s creator can heart a comment.'
          : 'Only the post\'s creator can pin a comment.',
      },
    };
  }
  if (update.kind === 'heart' && update.hearted && isAuthor) {
    return { ok: false, status: 400, body: { error: 'You cannot heart your own comment.' } };
  }
  if (update.kind === 'pin' && update.pinned && comment.parent_comment_id) {
    return { ok: false, status: 400, body: { error: 'Only a top-level comment can be pinned.' } };
  }
  if (update.kind === 'edit' || (update.kind === 'reaction' && update.reaction !== null)) {
    // The thread hides a blocked pair from each other, so the page never
    // offers either; a request made by hand, or from a page opened before the
    // block, is refused the same as a new comment or reply is. An edit is new
    // words on the post, so it answers to the people a new comment would: the
    // post's creator and, for a reply, the comment replied to. Taking a
    // reaction back is always allowed.
    const counterparts = new Set<string>();
    if (post.user_id) counterparts.add(String(post.user_id));
    if (update.kind === 'reaction') {
      counterparts.add(String(comment.user_id));
    } else if (comment.parent_comment_id) {
      const { data: parent, error: parentError } = await adminSupabase
        .from('post_comments')
        .select('user_id')
        .eq('id', comment.parent_comment_id)
        .maybeSingle();

      if (parentError) {
        logBackendError('failed_to_load_parent_post_comment_for_edit', { error: parentError });
        return { ok: false, status: 500, body: { error: failure } };
      }
      if (parent?.user_id) counterparts.add(String(parent.user_id));
    }
    counterparts.delete(actorUserId);

    const blocked = await Promise.all([...counterparts].map((counterpartUserId) => (
      isCommentInteractionBlocked({ actorUserId, counterpartUserId, adminSupabase, checkRelationshipBlocked })
    )));
    if (blocked.some(Boolean)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: update.kind === 'edit'
            ? 'Editing is unavailable on this comment.'
            : 'Reacting is unavailable on this comment.',
        },
      };
    }
  }

  const call = update.kind === 'edit'
    ? adminSupabase.rpc('edit_post_comment', {
        p_comment_id: normalizedCommentId, p_actor_user_id: actorUserId, p_body: update.body,
      })
    : update.kind === 'reaction'
      ? adminSupabase.rpc('set_post_comment_reaction', {
          p_comment_id: normalizedCommentId, p_user_id: actorUserId, p_reaction: update.reaction ?? 'none',
        })
      : update.kind === 'heart'
        ? adminSupabase.rpc('set_post_comment_heart', {
            p_comment_id: normalizedCommentId, p_actor_user_id: actorUserId, p_hearted: update.hearted,
          })
        : adminSupabase.rpc('set_post_comment_pin', {
            p_comment_id: normalizedCommentId, p_actor_user_id: actorUserId, p_pinned: update.pinned,
          });
  const { data: changed, error: updateError } = await call;

  if (updateError) {
    // The checks above are repeated inside each function under the row's
    // lock. One of these three lost a race: the comment was removed, or the
    // post taken down, between the read and the write. That is the 404 the
    // same request would have had a moment later, not a fault to retry.
    if (UPDATE_LOST_RACE.test(String(updateError.message ?? ''))) {
      return { ok: false, status: 404, body: { error: 'That comment is no longer available.' } };
    }

    logBackendError('failed_to_update_post_comment', { error: updateError, kind: update.kind });
    return { ok: false, status: 500, body: { error: failure } };
  }

  const result = ((Array.isArray(changed) ? changed[0] : changed) ?? {}) as {
    body?: string | null;
    edited_at?: string | null;
    changed?: boolean | null;
    like_count?: number | null;
    unpinned_comment_id?: string | null;
  };

  // Answered from the row read above with the function's own result laid over
  // it, not from a second read: the change is in the database by now, and a
  // read that failed here would tell the reader it was not. Each function
  // returns what it alone decides (the count another reader may have moved,
  // whether the words changed and so whether the heart came off).
  const now = new Date().toISOString();
  const updatedRow: CommentRow = {
    ...comment,
    ...(update.kind === 'edit'
      ? result.changed === false
        ? {}
        : { body: result.body ?? update.body, edited_at: result.edited_at ?? now, hearted_at: null }
      : update.kind === 'reaction'
        ? { like_count: result.like_count ?? comment.like_count }
        : update.kind === 'heart'
          ? { hearted_at: update.hearted ? comment.hearted_at ?? now : null }
          : { pinned_at: update.pinned ? comment.pinned_at ?? now : null }),
  };

  const [profiles, viewerReactions] = await Promise.all([
    loadCommentAuthors(adminSupabase, [updatedRow.user_id]),
    update.kind === 'reaction'
      ? new Map(update.reaction ? [[updatedRow.id, update.reaction] as const] : [])
      : loadViewerReactions(adminSupabase, actorUserId, [updatedRow.id]),
  ]);

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      comment: toPostCommentItem(updatedRow, profiles, viewerReactions),
      unpinnedCommentId: update.kind === 'pin' ? result.unpinned_comment_id ?? null : null,
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
