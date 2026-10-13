import type { InfiniteData } from '@tanstack/react-query';

import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type {
  PostComment,
  PostCommentsResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import { ApiError } from './api-client';
import { formatCompactCount, formatRelativeTime } from './home-view-model';

export const POST_COMMENTS_PAGE_SIZE = 20;
export const POST_COMMENT_MAX_LENGTH = 2000;
export const DELETED_COMMENT_LABEL = '[deleted]';

export type PostCommentSort = 'top' | 'newest';

export interface CommentDisplay {
  isDeleted: boolean;
  bodyText: string;
  authorLabel: string;
  timeLabel: string;
}

const POST_COMMENTS_QUERY_ROOT = 'post-comments';
const POST_COMMENT_REPLIES_QUERY_ROOT = 'post-comment-replies';

/**
 * Prefixes matching every cached thread and reply list, whatever the post,
 * sort or viewer: a block hides its author from all of them at once.
 */
export const ALL_POST_COMMENT_QUERY_KEYS = [
  [POST_COMMENTS_QUERY_ROOT],
  [POST_COMMENT_REPLIES_QUERY_ROOT],
] as const;

export function createPostCommentsQueryKey(
  postId: string,
  sort: PostCommentSort,
  viewerUserId?: string | null
) {
  return [POST_COMMENTS_QUERY_ROOT, postId, sort, viewerUserId?.trim() || 'anonymous'] as const;
}

export function createPostCommentRepliesQueryKey(
  postId: string,
  parentId: string,
  viewerUserId?: string | null
) {
  return [POST_COMMENT_REPLIES_QUERY_ROOT, postId, parentId, viewerUserId?.trim() || 'anonymous'] as const;
}

export function flattenCommentPages(pages: PostCommentsResponse[] | undefined) {
  const seen = new Set<string>();
  const comments: PostComment[] = [];

  for (const page of pages ?? []) {
    for (const comment of page?.comments ?? []) {
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      comments.push(comment);
    }
  }

  return comments;
}

/**
 * The top-level thread with the viewer's own new comments pinned above it,
 * newest first. Under Top the server ranks by reply count, so on a busy post a
 * comment with no replies yet falls past page 1 and would vanish on the
 * refetch that follows posting it. The server's copy of a pinned comment wins
 * once a loaded page holds it (a newer reply count, a removal), and it is
 * listed once, in the pinned place.
 */
export function mergeTopLevelWithPending(
  pages: PostCommentsResponse[] | undefined,
  pendingTopLevel: PostComment[] = []
) {
  const server = flattenCommentPages(pages);
  if (!pendingTopLevel.length) return server;
  const serverById = new Map(server.map((comment) => [comment.id, comment]));
  const pinnedIds = new Set(pendingTopLevel.map((comment) => comment.id));
  return [
    ...pendingTopLevel.map((comment) => serverById.get(comment.id) ?? comment),
    ...server.filter((comment) => !pinnedIds.has(comment.id)),
  ];
}

export function mergeRepliesWithPending(
  pages: PostCommentsResponse[] | undefined,
  pendingReplies: PostComment[] = []
) {
  const seen = new Set<string>();
  return [...flattenCommentPages(pages), ...pendingReplies]
    .filter((comment) => {
      if (seen.has(comment.id)) return false;
      seen.add(comment.id);
      return true;
    })
    .sort((left, right) => (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    ));
}

export function getNextCommentsPageOffset(lastPage: PostCommentsResponse | undefined) {
  if (!lastPage?.pageInfo?.hasMore) return undefined;
  return lastPage.pageInfo.nextOffset ?? undefined;
}

export function getCommentsPageParams({
  offset = 0,
  parentId,
  sort = 'top',
  limit = POST_COMMENTS_PAGE_SIZE,
}: {
  offset?: number;
  parentId?: string | null;
  sort?: PostCommentSort;
  limit?: number;
} = {}) {
  return {
    limit,
    offset,
    sort,
    ...(parentId ? { parentId } : {}),
  };
}

export function getCommentAuthReturnTo(
  returnTo: string | null | undefined,
  postId: string,
  replyToId?: string | null
) {
  const base = returnTo?.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : '/(tabs)/index';
  const hashIndex = base.indexOf('#');
  const path = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : '';
  const separator = path.includes('?') ? '&' : '?';
  const params = [
    `comments=${encodeURIComponent(postId)}`,
    ...(replyToId ? [`replyTo=${encodeURIComponent(replyToId)}`] : []),
  ];
  return `${path}${separator}${params.join('&')}${hash}`;
}

export function getCommentCountLabel(count: number | null | undefined) {
  return formatCompactCount(count);
}

export function getCommentDisplay(comment: PostComment, now = new Date()): CommentDisplay {
  const isDeleted = comment.status !== 'active';

  return {
    isDeleted,
    bodyText: isDeleted ? DELETED_COMMENT_LABEL : comment.body,
    authorLabel: isDeleted
      ? DELETED_COMMENT_LABEL
      : comment.author?.username
        ? `@${comment.author.username}`
        : comment.author?.displayName ?? 'Creator',
    timeLabel: formatRelativeTime(comment.createdAt, now),
  };
}

export function getRepliesToggleLabel(replyCount: number, expanded: boolean) {
  if (expanded) return 'Hide replies';
  return `View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
}

/**
 * The question before a delete or an owner's removal. The server keeps a
 * removed comment as "[deleted]" only while it holds replies; one without
 * replies is removed outright, and the author's copy says so.
 */
export function getRemoveCommentConfirmation(comment: PostComment, asOwner: boolean) {
  if (asOwner) {
    return {
      title: 'Remove this comment?',
      message: 'It will be hidden from everyone viewing your post.',
      confirmLabel: 'Remove',
    };
  }
  return {
    title: 'Delete your comment?',
    message: comment.replyCount > 0
      ? `Your comment will be replaced with “${DELETED_COMMENT_LABEL}”. Replies to it stay visible.`
      : 'It will be removed.',
    confirmLabel: 'Delete',
  };
}

export function canDeleteComment(comment: PostComment, viewerUserId: string | null | undefined) {
  return comment.status === 'active'
    && Boolean(viewerUserId)
    && comment.author?.id === viewerUserId;
}

export function canRemoveComment(
  comment: PostComment,
  postCreatorId: string | null | undefined,
  viewerUserId: string | null | undefined
) {
  return comment.status === 'active'
    && Boolean(viewerUserId)
    && Boolean(postCreatorId)
    && postCreatorId === viewerUserId
    && comment.author?.id !== viewerUserId;
}

export function canReportComment(comment: PostComment, viewerUserId: string | null | undefined) {
  return comment.status === 'active'
    && Boolean(viewerUserId)
    && comment.author?.id !== viewerUserId;
}

/**
 * Block from a comment: someone else's comment, with the viewer signed in. Not
 * the post's creator: blocking them hides the post itself, which the post's
 * own menu does while taking it off the screen, and their profile (a tap on
 * the comment's author) offers Block as well.
 */
export function canBlockCommentAuthor(
  comment: PostComment,
  postCreatorId: string | null | undefined,
  viewerUserId: string | null | undefined
) {
  const authorId = comment.author?.id;
  return comment.status === 'active'
    && Boolean(viewerUserId)
    && Boolean(authorId)
    && authorId !== viewerUserId
    && authorId !== postCreatorId;
}

export function prependCommentToPages(
  data: InfiniteData<PostCommentsResponse> | undefined,
  comment: PostComment,
  commentCount: number
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages?.length) return data;

  return {
    ...data,
    pages: data.pages.map((page, index) => {
      if (index !== 0) return { ...page, commentCount };
      const combined = [
        comment,
        ...page.comments.filter((current) => current.id !== comment.id),
      ];
      const limit = Math.max(1, page.pageInfo.limit || POST_COMMENTS_PAGE_SIZE);
      const hasMore = page.pageInfo.hasMore || combined.length > limit;
      return {
        ...page,
        commentCount,
        comments: combined.slice(0, limit),
        pageInfo: {
          ...page.pageInfo,
          hasMore,
          nextOffset: hasMore ? limit : null,
          offset: 0,
        },
      };
    }),
  };
}

export function appendReplyToPages(
  data: InfiniteData<PostCommentsResponse> | undefined,
  reply: PostComment,
  commentCount?: number
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages?.length) return data;

  const lastIndex = data.pages.length - 1;
  return {
    ...data,
    pages: data.pages.map((page, index) => (index === lastIndex
      ? {
          ...page,
          ...(typeof commentCount === 'number' ? { commentCount } : {}),
          comments: page.comments.some((comment) => comment.id === reply.id)
            ? page.comments
            : [...page.comments, reply],
        }
      : typeof commentCount === 'number' ? { ...page, commentCount } : page)),
  };
}

/**
 * Offset pagination becomes invalid after an insertion or removal. Keep the
 * authoritative first page and let the active query rebuild subsequent pages
 * from the server before another load-more request.
 */
export function keepFirstCommentPage(
  data: InfiniteData<PostCommentsResponse> | undefined
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages?.length) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}

export function suspendCommentPagination(
  data: InfiniteData<PostCommentsResponse> | undefined
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages?.length) return data;
  const lastIndex = data.pages.length - 1;
  return {
    ...data,
    pages: data.pages.map((page, index) => index === lastIndex
      ? {
          ...page,
          pageInfo: {
            ...page.pageInfo,
            hasMore: false,
            nextOffset: null,
          },
        }
      : page),
  };
}

/** Returns the same list when it does not hold the comment. */
export function markCommentRemovedInList(
  comments: PostComment[],
  commentId: string,
  status: PostComment['status']
): PostComment[] {
  if (!comments.some((comment) => comment.id === commentId)) return comments;
  return comments.flatMap((comment) => {
    if (comment.id !== commentId) return [comment];
    // A removed comment stays only while it still anchors replies.
    if (comment.replyCount <= 0) return [];
    return [{ ...comment, status, body: '', author: null }];
  });
}

/** Returns the same list when it does not hold the parent. */
export function incrementReplyCountInList(
  comments: PostComment[],
  parentId: string,
  delta: number
): PostComment[] {
  if (!comments.some((comment) => comment.id === parentId)) return comments;
  return comments.map((comment) => (comment.id === parentId
    ? { ...comment, replyCount: Math.max(0, comment.replyCount + delta) }
    : comment));
}

export function markCommentRemovedInPages(
  data: InfiniteData<PostCommentsResponse> | undefined,
  commentId: string,
  status: PostComment['status'],
  commentCount: number
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages) return data;

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      commentCount,
      comments: markCommentRemovedInList(page.comments, commentId, status),
    })),
  };
}

export function incrementParentReplyCountInPages(
  data: InfiniteData<PostCommentsResponse> | undefined,
  parentId: string,
  delta: number,
  commentCount?: number
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages) return data;

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      ...(typeof commentCount === 'number' ? { commentCount } : {}),
      comments: incrementReplyCountInList(page.comments, parentId, delta),
    })),
  };
}

export const COMMENTS_CLOSED_TITLE = 'Comments are closed on this post';

function errorStatus(error: unknown) {
  return error instanceof ApiError ? error.status : null;
}

/** How long a 429 asked the client to wait, when its body said. */
function retryAfterSeconds(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const details = error.details;
  const seconds = details && typeof details === 'object'
    ? Number((details as { retryAfterSeconds?: unknown }).retryAfterSeconds)
    : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function waitSentence(error: unknown) {
  const seconds = retryAfterSeconds(error);
  if (seconds === null) return 'Wait a moment, then try again.';
  if (seconds < 60) return `Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

export interface CommentsLoadErrorCopy {
  title: string;
  body?: string;
  /** False when asking again cannot change the answer. */
  canRetry: boolean;
}

/**
 * A failed thread load, named by its cause rather than by the request. A 404
 * is a post no longer public or visible to this viewer (a block either way
 * with its creator reads the same), which trying again cannot open. A 429
 * clears with time. Only a request that never reached the server is a
 * connection problem.
 */
export function getCommentsLoadErrorCopy(error: unknown): CommentsLoadErrorCopy {
  const status = errorStatus(error);
  if (status === 404) return { title: COMMENTS_CLOSED_TITLE, canRetry: false };
  if (status === 429) {
    return {
      title: 'Comments are unavailable',
      body: `Too many requests in a short time. ${waitSentence(error)}`,
      canRetry: true,
    };
  }
  return {
    title: 'Comments are unavailable',
    body: status === null || status === 0
      ? 'We could not load this conversation. Check your connection, then try again.'
      : 'We could not load this conversation. Try again in a moment.',
    canRetry: true,
  };
}

export interface CommentPostErrorCopy {
  title: string;
  message?: string;
  /** The session behind the post ended: the dialog's way forward is to sign in. */
  signIn: boolean;
}

/**
 * A failed comment or reply. A 401 is a session that ended after the thread
 * opened (the app drops back to a guest when the server refuses it), so it
 * says that rather than the server's "Unauthorized". A 404 on a new comment is
 * a post that closed meanwhile; on a reply it can also be a parent removed
 * meanwhile, which the server's own text names.
 */
export function getCommentPostErrorCopy(error: unknown, isReply: boolean): CommentPostErrorCopy {
  const status = errorStatus(error);
  if (status === 401) return { title: 'Your session ended', message: 'Sign in to post.', signIn: true };
  if (status === 404 && !isReply) return { title: COMMENTS_CLOSED_TITLE, signIn: false };
  if (status === 429) {
    return {
      title: 'Could not post comment',
      message: `You're commenting too quickly. ${waitSentence(error)}`,
      signIn: false,
    };
  }
  return {
    title: 'Could not post comment',
    message: error instanceof Error && error.message.trim() ? error.message : 'Please try again.',
    signIn: false,
  };
}

export interface CommentCountResult {
  postId: string;
  commentCount: number;
}

function updateItemCommentCount<T extends { id: string; commentCount: number }>(
  item: T,
  result: CommentCountResult
) {
  if (item.id !== result.postId) return item;
  return { ...item, commentCount: Math.max(0, result.commentCount) };
}

export function applyCommentCountToFeedResponse(
  response: ShowcaseFeedResponse | undefined,
  result: CommentCountResult
): ShowcaseFeedResponse | undefined {
  if (!response) return response;
  return { ...response, items: response.items.map((item) => updateItemCommentCount(item, result)) };
}

export function applyCommentCountToInfiniteFeed(
  data: InfiniteData<ShowcaseFeedResponse> | undefined,
  result: CommentCountResult
): InfiniteData<ShowcaseFeedResponse> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => applyCommentCountToFeedResponse(page, result) ?? page),
  };
}

export function applyCommentCountToPostResponse(
  response: ShowcasePostResponse | undefined,
  result: CommentCountResult
): ShowcasePostResponse | undefined {
  if (!response?.item) return response;
  return { ...response, item: updateItemCommentCount(response.item, result) };
}

export function applyCommentCountToSourceData(
  data: ImmersiveSourceData | undefined,
  result: CommentCountResult
): ImmersiveSourceData | undefined {
  if (!data) return data;
  return {
    ...data,
    ...(data.showcaseItems
      ? { showcaseItems: data.showcaseItems.map((item) => updateItemCommentCount(item, result)) }
      : {}),
    ...(data.ownerPosts
      ? { ownerPosts: data.ownerPosts.map((item) => updateItemCommentCount(item, result)) }
      : {}),
  };
}
