/**
 * Browser-side comment logic: thread assembly, permissions, the local
 * updates that keep a page consistent after a create or a remove, and the copy
 * for a failed request.
 *
 * Kept out of the component so it can be unit-tested without rendering, and
 * deliberately parallel to `ugc-mobile/lib/comments-view-model.ts` — the two
 * clients share no code, so the same rules are asserted on both sides.
 *
 * This module must stay free of `server-only` imports: `post-comments-service`
 * is server-side, so its shapes are re-declared here instead of imported.
 */

export type PostCommentStatus =
    | 'active'
    | 'removed_by_author'
    | 'removed_by_owner'
    | 'removed_by_moderation';

export interface PostCommentAuthor {
    id: string;
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
}

export interface PostComment {
    id: string;
    parentId: string | null;
    body: string;
    status: PostCommentStatus;
    createdAt: string;
    replyCount: number;
    /** Null once a comment is removed — the server withholds the author too. */
    author: PostCommentAuthor | null;
}

export interface PostCommentsPage {
    postId: string;
    postCreatorId: string | null;
    commentCount: number;
    comments: PostComment[];
    pageInfo: {
        hasMore: boolean;
        nextOffset: number | null;
        limit: number;
        offset: number;
    };
}

export type PostCommentSort = 'top' | 'newest';

export const POST_COMMENTS_PAGE_SIZE = 20;
/** The most comments the server returns for one read (`POST_COMMENT_MAX_PAGE_SIZE`). */
export const POST_COMMENTS_MAX_PAGE_SIZE = 50;
export const POST_COMMENT_MAX_LENGTH = 2000;
export const DELETED_COMMENT_LABEL = '[deleted]';

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
    authorHref: string | null;
}

export function getCommentDisplay(comment: PostComment): CommentDisplay {
    const isDeleted = comment.status !== 'active';
    const username = comment.author?.username?.trim();

    return {
        isDeleted,
        bodyText: isDeleted ? DELETED_COMMENT_LABEL : comment.body,
        authorLabel: isDeleted
            ? DELETED_COMMENT_LABEL
            : username
                ? `@${username}`
                : comment.author?.displayName ?? 'Creator',
        authorHref: !isDeleted && username ? `/creators/${encodeURIComponent(username)}` : null,
    };
}

/**
 * Flattens top-level comments plus any expanded reply sets into one render
 * list. The product intentionally supports one reply level, so callers only
 * pass replies whose parent is a top-level comment.
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

export function prependComment(comments: PostComment[], comment: PostComment) {
    return [comment, ...comments.filter((existing) => existing.id !== comment.id)];
}

/**
 * Appends a server page without trusting offset boundaries to be immutable.
 * Creating, removing, or re-ranking a comment can move rows between offset
 * pages while the conversation is open, so id-based de-duplication is required
 * even when the backend returns a well-formed page.
 */
export function mergeCommentPage(
    comments: PostComment[],
    incoming: PostComment[],
    replace = false
) {
    const seen = new Set<string>();
    const source = replace ? incoming : [...comments, ...incoming];

    return source.filter((comment) => {
        if (seen.has(comment.id)) return false;
        seen.add(comment.id);
        return true;
    });
}

/**
 * Adds the viewer's own just-posted comments that the loaded list does not
 * hold. A server re-read can leave a new comment out (under Top every comment
 * with replies ranks ahead of it), and a new reply belongs after replies not
 * loaded yet; dropping either would make the post look as if it failed. New
 * top-level comments lead the list; a new reply, the newest in its thread,
 * closes it.
 */
export function withPendingComments(
    loaded: PostComment[],
    pending: PostComment[],
    placement: 'first' | 'last'
) {
    if (pending.length === 0) return loaded;
    const loadedIds = new Set(loaded.map((comment) => comment.id));
    const missing = pending.filter((comment) => !loadedIds.has(comment.id));
    if (missing.length === 0) return loaded;
    return placement === 'first' ? [...missing, ...loaded] : [...loaded, ...missing];
}

/**
 * A removed comment keeps its row only while it still anchors replies; the
 * server has already withheld its body and author, and this mirrors that so the
 * list does not flash the old text before a refetch.
 */
export function markCommentRemoved(
    comments: PostComment[],
    commentId: string,
    status: PostCommentStatus
) {
    return comments.flatMap((comment) => {
        if (comment.id !== commentId) return [comment];
        if (comment.replyCount <= 0) return [];
        return [{ ...comment, status, body: '', author: null }];
    });
}

export function adjustReplyCount(comments: PostComment[], parentId: string, delta: number) {
    return comments.map((comment) => (comment.id === parentId
        ? { ...comment, replyCount: Math.max(0, comment.replyCount + delta) }
        : comment));
}

export function buildCommentsQuery({
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
    const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        sort,
    });
    if (parentId) params.set('parentId', parentId);
    return params.toString();
}

/** What the thread was doing when a request failed; it picks the copy. */
export type CommentRequestKind = 'load' | 'replies' | 'post' | 'reply' | 'remove' | 'report';

export interface CommentRequestFailure {
    message: string;
    /** False when trying again cannot help: the thread or the comment is gone. */
    retryable: boolean;
    /** The session behind the request ended; the reader has to sign in again. */
    signIn: boolean;
}

const COMMENT_REQUEST_FALLBACKS: Record<CommentRequestKind, string> = {
    load: 'We could not load this conversation.',
    replies: 'Could not load replies.',
    post: 'Could not post comment.',
    reply: 'Could not post reply.',
    remove: 'Could not remove comment.',
    report: 'Could not report that comment.',
};

function formatWait(seconds: number) {
    if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Copy for a failed comment request, picked by HTTP status so the reader learns
 * the cause instead of being sent to check a working connection: a thread
 * closed to them (404: not public any more, or a block either way with its
 * creator) is not worth retrying, a rate limit (429) says how long to wait, and
 * an ended session (401) asks for sign-in. Other failures keep the server's own
 * words for writes. Reads never show server text, and a body that was not JSON
 * (a gateway page) or a request that got no answer (`status` null) gets plain
 * copy rather than a parser's message.
 */
export function describeCommentRequestFailure(
    kind: CommentRequestKind,
    status: number | null,
    body?: { error?: unknown; retryAfterSeconds?: unknown } | null
): CommentRequestFailure {
    const isRead = kind === 'load' || kind === 'replies';

    if (status === 401) {
        return {
            message: kind === 'post' || kind === 'reply'
                ? 'Your session ended. Sign in to post.'
                : 'Your session ended. Sign in again to continue.',
            retryable: true,
            signIn: true,
        };
    }

    if (status === 404) {
        return {
            message: isRead || kind === 'post'
                ? 'Comments are closed on this post.'
                : 'That comment is no longer available.',
            retryable: false,
            signIn: false,
        };
    }

    if (status === 429) {
        const retryAfter = typeof body?.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0
            ? Math.ceil(body.retryAfterSeconds)
            : null;
        return {
            message: retryAfter
                ? `Too many requests. Wait ${formatWait(retryAfter)}, then try again.`
                : 'Too many requests. Wait a moment, then try again.',
            retryable: true,
            signIn: false,
        };
    }

    const serverMessage = !isRead && typeof body?.error === 'string' && body.error.trim()
        ? body.error.trim()
        : null;
    return {
        message: serverMessage ?? COMMENT_REQUEST_FALLBACKS[kind],
        retryable: true,
        signIn: false,
    };
}
