/**
 * Browser-side comment logic: thread assembly, permissions, and the local
 * updates that keep a page consistent after a create or a remove.
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
    replyLabel: string | null;
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
        replyLabel: comment.replyCount > 0
            ? `${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`
            : null,
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

export function getCommentCountLabel(count: number) {
    if (count <= 0) return 'Comment';
    return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}
