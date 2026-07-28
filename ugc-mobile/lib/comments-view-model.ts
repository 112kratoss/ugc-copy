import type { InfiniteData } from '@tanstack/react-query';

import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type {
  PostComment,
  PostCommentsResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import { formatCompactCount, formatRelativeTime } from './home-view-model';

export const POST_COMMENTS_PAGE_SIZE = 20;
export const POST_COMMENT_MAX_LENGTH = 2000;
export const DELETED_COMMENT_LABEL = '[deleted]';

export type PostCommentSort = 'top' | 'newest';

export interface CommentThreadRow {
  kind: 'comment' | 'reply' | 'replies-toggle';
  key: string;
  comment?: PostComment;
  parentId?: string;
  replyCount?: number;
  expanded?: boolean;
}

export interface CommentDisplay {
  isDeleted: boolean;
  bodyText: string;
  authorLabel: string;
  timeLabel: string;
  replyLabel: string | null;
}

export function createPostCommentsQueryKey(
  postId: string,
  sort: PostCommentSort,
  viewerUserId?: string | null
) {
  return ['post-comments', postId, sort, viewerUserId?.trim() || 'anonymous'] as const;
}

export function createPostCommentRepliesQueryKey(
  postId: string,
  parentId: string,
  viewerUserId?: string | null
) {
  return ['post-comment-replies', postId, parentId, viewerUserId?.trim() || 'anonymous'] as const;
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
    replyLabel: comment.replyCount > 0
      ? `${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`
      : null,
  };
}

/**
 * Flattens top-level comments plus any expanded reply sets into a single render
 * list. The API and UI share a one-level thread contract: replies always point
 * at a top-level parent.
 */
export function buildCommentThreads({
  topLevel,
  repliesByParent = {},
  expandedIds = new Set<string>(),
}: {
  topLevel: PostComment[];
  repliesByParent?: Record<string, PostComment[]>;
  expandedIds?: Set<string>;
}): CommentThreadRow[] {
  const rows: CommentThreadRow[] = [];

  for (const comment of topLevel) {
    rows.push({ kind: 'comment', key: comment.id, comment });

    const expanded = expandedIds.has(comment.id);
    if (expanded) {
      for (const reply of repliesByParent[comment.id] ?? []) {
        rows.push({ kind: 'reply', key: reply.id, comment: reply, parentId: comment.id });
      }
    }

    if (comment.replyCount > 0) {
      rows.push({
        kind: 'replies-toggle',
        key: `${comment.id}:toggle`,
        parentId: comment.id,
        replyCount: comment.replyCount,
        expanded,
      });
    }
  }

  return rows;
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
      comments: page.comments.flatMap((comment) => {
        if (comment.id !== commentId) return [comment];
        // A removed comment stays only while it still anchors replies.
        if (comment.replyCount <= 0) return [];
        return [{ ...comment, status, body: '', author: null }];
      }),
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
      comments: page.comments.map((comment) => (comment.id === parentId
        ? { ...comment, replyCount: Math.max(0, comment.replyCount + delta) }
        : comment)),
    })),
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
