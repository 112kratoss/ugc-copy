import type { InfiniteData } from '@tanstack/react-query';

import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type {
  PostComment,
  PostCommentReaction,
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

/**
 * The thread's orders, with the web's ids and words
 * (`src/components/PostComments.tsx`, `SORTS`), so a thread reads the same
 * whichever client opens it. Every thread opens on Top, as the web's does.
 */
export const POST_COMMENT_SORTS: ReadonlyArray<{ id: PostCommentSort; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'newest', label: 'Newest' },
];
export const DEFAULT_POST_COMMENT_SORT: PostCommentSort = 'top';

export interface CommentDisplay {
  isDeleted: boolean;
  bodyText: string;
  authorLabel: string;
  /** Its age, and "(edited)" after it once its author has changed its words. */
  timeLabel: string;
}

/** The line over the post's one pinned comment, and what a heart reads as; the web's words. */
export const PINNED_COMMENT_LABEL = 'Pinned by the creator';
export const HEARTED_COMMENT_LABEL = 'Loved by the creator';

/** A comment longer than this many characters, or lines, opens folded (the web's numbers). */
export const COMMENT_FOLD_MAX_LENGTH = 320;
export const COMMENT_FOLD_MAX_LINES = 4;

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

/**
 * One post's thread in every order and for every viewer. A new or removed
 * comment is written into the order on screen; the other order's pages, read
 * before it, are stale from then on.
 */
export function createPostCommentsThreadQueryKey(postId: string) {
  return [POST_COMMENTS_QUERY_ROOT, postId] as const;
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
 * The top-level thread with the viewer's own new comments held above it,
 * newest first. Under Top the server ranks by likes and replies, so on a busy
 * post a new comment falls past page 1 and would vanish on the refetch that
 * follows posting it. The server's copy of a held comment wins once a loaded
 * page holds it (a newer reply count, a removal), and it is listed once, in
 * the held place. The comment the post's creator pinned stays first, above
 * them: it leads the thread for every reader.
 */
export function mergeTopLevelWithPending(
  pages: PostCommentsResponse[] | undefined,
  pendingTopLevel: PostComment[] = []
) {
  const server = flattenCommentPages(pages);
  if (!pendingTopLevel.length) return server;
  const serverById = new Map(server.map((comment) => [comment.id, comment]));
  const heldIds = new Set(pendingTopLevel.map((comment) => comment.id));
  const rest = server.filter((comment) => !heldIds.has(comment.id));
  const held = pendingTopLevel.map((comment) => serverById.get(comment.id) ?? comment);
  return [
    ...rest.filter((comment) => comment.pinned),
    // One of the viewer's own just-posted comments may be the pinned one.
    ...held.filter((comment) => comment.pinned),
    ...held.filter((comment) => !comment.pinned),
    ...rest.filter((comment) => !comment.pinned),
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
    timeLabel: `${formatRelativeTime(comment.createdAt, now)}${!isDeleted && comment.editedAt ? ' (edited)' : ''}`,
  };
}

/**
 * Whether a comment opens folded behind "Read more": a long one would
 * otherwise push every comment after it off a sheet. Counted on the text, as
 * the web's thread does.
 */
export function isLongComment(body: string): boolean {
  return body.length > COMMENT_FOLD_MAX_LENGTH
    || body.split('\n').length > COMMENT_FOLD_MAX_LINES;
}

/** The post's own creator, marked in the thread so their answers stand out. */
export function isPostCreatorComment(
  comment: PostComment,
  postCreatorId: string | null | undefined
): boolean {
  return comment.status === 'active'
    && Boolean(postCreatorId)
    && comment.author?.id === postCreatorId;
}

/**
 * What a reply's draft opens with. A reply to a reply joins the same thread
 * (the product keeps one reply level), so it names who it answers; a reply to
 * the top comment needs no name, and neither does an author without a handle.
 */
export function buildReplyDraftPrefix(target: PostComment): string {
  if (!target.parentId) return '';
  const username = target.author?.username?.trim();
  return username ? `@${username} ` : '';
}

/**
 * The draft a reply starts from when its target is chosen. A draft under way
 * is kept; one that is empty, or still only the last target's handle, becomes
 * the new target's handle (nothing, for a top-level comment).
 */
export function draftForReplyTarget(draft: string, previousPrefix: string, target: PostComment): string {
  return draft.trim() === '' || draft === previousPrefix ? buildReplyDraftPrefix(target) : draft;
}

/** An edit whose words differ from the comment's: leaving it would lose them. */
export function hasUnsavedCommentEdit(draft: string, editing: PostComment | null): boolean {
  return editing !== null && draft.trim() !== editing.body.trim();
}

/** A reply's opening handle alone is nothing to send, and neither is an unchanged edit. */
export function hasCommentToSend(draft: string, replyPrefix: string, editingBody: string | null): boolean {
  const body = draft.trim();
  if (!body) return false;
  if (editingBody !== null) return body !== editingBody.trim();
  return replyPrefix === '' || body !== replyPrefix.trim();
}

/** Pressing the reaction already given takes it back; the other one replaces it. */
export function nextCommentReaction(
  current: PostCommentReaction | null | undefined,
  pressed: PostCommentReaction
): PostCommentReaction | null {
  return current === pressed ? null : pressed;
}

/**
 * The comment as it reads the moment the reader presses, before the server
 * answers: their reaction, and the like count moved by their own like alone.
 */
export function applyOwnCommentReaction(
  comment: PostComment,
  next: PostCommentReaction | null
): PostComment {
  const had = comment.viewerReaction === 'like' ? 1 : 0;
  const has = next === 'like' ? 1 : 0;
  return {
    ...comment,
    viewerReaction: next,
    likeCount: Math.max(0, (comment.likeCount ?? 0) + has - had),
  };
}

/** The like count beside the thumb: nothing at zero, as the web shows it. */
export function getCommentLikeCountLabel(comment: PostComment): string {
  const count = comment.likeCount ?? 0;
  return count > 0 ? formatCompactCount(count) : '';
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

/** Its author may reword a comment, as they may delete it. */
export function canEditComment(comment: PostComment, viewerUserId: string | null | undefined) {
  return canDeleteComment(comment, viewerUserId);
}

/** The heart is the post's creator marking someone else's comment or reply. */
export function canHeartComment(
  comment: PostComment,
  postCreatorId: string | null | undefined,
  viewerUserId: string | null | undefined
) {
  return canRemoveComment(comment, postCreatorId, viewerUserId);
}

/** The post's creator pins one top-level comment, their own included. */
export function canPinComment(
  comment: PostComment,
  postCreatorId: string | null | undefined,
  viewerUserId: string | null | undefined
) {
  return comment.status === 'active'
    && !comment.parentId
    && Boolean(viewerUserId)
    && Boolean(postCreatorId)
    && postCreatorId === viewerUserId;
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
/**
 * Moves a comment to the head of the first page, out of whichever page held
 * it: where the comment a creator just pinned belongs before the server's
 * order is read again. A thread with no page yet is left as it is.
 */
export function leadCommentPagesWith(
  data: InfiniteData<PostCommentsResponse> | undefined,
  comment: PostComment
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages?.length) return data;
  if (data.pages[0].comments[0]?.id === comment.id) return data;
  const pages = data.pages.map((page, index) => {
    const others = page.comments.filter((item) => item.id !== comment.id);
    if (index === 0) return { ...page, comments: [comment, ...others] };
    return others.length === page.comments.length ? page : { ...page, comments: others };
  });
  return { ...data, pages };
}

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
    // As the server sends a removed comment: no likes, heart, pin or edit stamp.
    return [{
      ...comment,
      status,
      body: '',
      author: null,
      likeCount: 0,
      viewerReaction: null,
      editedAt: null,
      hearted: false,
      pinned: false,
    }];
  });
}

/** Changes one comment where a list holds it; returns the same list when it does not. */
export function mapCommentInList(
  comments: PostComment[],
  commentId: string,
  change: (comment: PostComment) => PostComment
): PostComment[] {
  if (!comments.some((comment) => comment.id === commentId)) return comments;
  return comments.map((comment) => (comment.id === commentId ? change(comment) : comment));
}

/** Changes one comment on whichever cached page holds it. */
export function mapCommentInPages(
  data: InfiniteData<PostCommentsResponse> | undefined,
  commentId: string,
  change: (comment: PostComment) => PostComment
): InfiniteData<PostCommentsResponse> | undefined {
  if (!data?.pages) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const comments = mapCommentInList(page.comments, commentId, change);
    if (comments === page.comments) return page;
    changed = true;
    return { ...page, comments };
  });
  return changed ? { ...data, pages } : data;
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

export type CommentUpdateKind = 'react' | 'edit' | 'heart' | 'pin';

const COMMENT_UPDATE_FAILURE_TITLES: Record<CommentUpdateKind, string> = {
  react: 'Could not save your reaction',
  edit: 'Could not save your edit',
  heart: 'Could not update the heart',
  pin: 'Could not update the pin',
};

/**
 * A failed like, edit, heart or pin. A 401 is a session that ended, a 404 a
 * comment removed (or a post closed) meanwhile; the rest keep the server's own
 * words, as a failed post does.
 */
export function getCommentUpdateErrorCopy(error: unknown, kind: CommentUpdateKind): CommentPostErrorCopy {
  const status = errorStatus(error);
  const title = COMMENT_UPDATE_FAILURE_TITLES[kind];
  if (status === 401) return { title: 'Your session ended', message: 'Sign in to continue.', signIn: true };
  if (status === 404) return { title, message: 'That comment is no longer available.', signIn: false };
  if (status === 429) return { title, message: `Too many requests in a short time. ${waitSentence(error)}`, signIn: false };
  return {
    title,
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
