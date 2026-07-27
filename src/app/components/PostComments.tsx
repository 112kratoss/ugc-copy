'use client';

import { Flag, Loader2, MessageSquare, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PostCommentAvatar from '@/app/components/PostCommentAvatar';
import { useAuth } from '@/app/components/AuthProvider';
import {
    POST_COMMENT_MAX_LENGTH,
    adjustReplyCount,
    buildCommentThreads,
    buildCommentsQuery,
    canDeleteComment,
    canRemoveComment,
    canReportComment,
    getCommentDisplay,
    markCommentRemoved,
    prependComment,
    type PostComment,
    type PostCommentSort,
    type PostCommentsPage,
} from '@/lib/post-comments-client';
import { formatRelativeTime } from '@/lib/post-feed-presentation';

const SORTS: Array<{ id: PostCommentSort; label: string }> = [
    { id: 'top', label: 'Top' },
    { id: 'newest', label: 'New' },
];

interface PostCommentsProps {
    postId: string;
    postCreatorId: string | null;
    commentCount: number;
    onCommentCountChange?: (commentCount: number) => void;
    /** Loads the first page immediately instead of waiting for a "load" tap. */
    autoLoad?: boolean;
}

export default function PostComments({
    postId,
    postCreatorId,
    commentCount,
    onCommentCountChange,
    autoLoad = true,
}: PostCommentsProps) {
    const { session, user } = useAuth();
    const accessToken = session?.access_token ?? null;

    const [sort, setSort] = useState<PostCommentSort>('top');
    const [comments, setComments] = useState<PostComment[]>([]);
    const [repliesByParent, setRepliesByParent] = useState<Record<string, PostComment[]>>({});
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [nextOffset, setNextOffset] = useState<number | null>(0);
    const [resolvedCreatorId, setResolvedCreatorId] = useState(postCreatorId);
    const [totalCount, setTotalCount] = useState(commentCount);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [replyTo, setReplyTo] = useState<PostComment | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [busyCommentId, setBusyCommentId] = useState<string | null>(null);

    const authHeaders = useCallback((json = false) => {
        const headers: Record<string, string> = {};
        if (json) headers['Content-Type'] = 'application/json';
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        return headers;
    }, [accessToken]);

    // Callers pass an inline arrow, so this callback has a new identity on every
    // render. Holding it in a ref keeps `loadPage` — and therefore the load
    // effect below — from re-running forever.
    const onCommentCountChangeRef = useRef(onCommentCountChange);
    useEffect(() => {
        onCommentCountChangeRef.current = onCommentCountChange;
    }, [onCommentCountChange]);

    const publishCount = useCallback((next: number) => {
        setTotalCount(next);
        onCommentCountChangeRef.current?.(next);
    }, []);

    const loadPage = useCallback(async (offset: number, replace: boolean) => {
        setLoading(true);
        setError(null);
        try {
            const query = buildCommentsQuery({ offset, sort });
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments?${query}`,
                { headers: authHeaders() }
            );
            if (!response.ok) throw new Error('Could not load comments');

            const page = await response.json() as PostCommentsPage;
            setComments((current) => (replace ? page.comments : [...current, ...page.comments]));
            setNextOffset(page.pageInfo.hasMore ? page.pageInfo.nextOffset : null);
            setResolvedCreatorId(page.postCreatorId ?? postCreatorId);
            publishCount(page.commentCount);
        } catch {
            setError('We could not load this conversation. Try again.');
        } finally {
            setLoading(false);
        }
    }, [authHeaders, postCreatorId, postId, publishCount, sort]);

    // Re-sorting is a full reload: `top` and `newest` are different orderings of
    // the same rows, so merging pages across them would interleave duplicates.
    useEffect(() => {
        if (!autoLoad) return;
        setComments([]);
        setRepliesByParent({});
        setExpandedIds(new Set());
        setNextOffset(0);
        void loadPage(0, true);
    }, [autoLoad, loadPage]);

    const toggleReplies = useCallback(async (parentId: string) => {
        if (expandedIds.has(parentId)) {
            setExpandedIds((current) => {
                const next = new Set(current);
                next.delete(parentId);
                return next;
            });
            return;
        }

        if (repliesByParent[parentId]) {
            setExpandedIds((current) => new Set(current).add(parentId));
            return;
        }

        setBusyCommentId(parentId);
        try {
            const query = buildCommentsQuery({ parentId });
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments?${query}`,
                { headers: authHeaders() }
            );
            if (!response.ok) throw new Error('Could not load replies');

            const page = await response.json() as PostCommentsPage;
            setRepliesByParent((current) => ({ ...current, [parentId]: page.comments }));
            setExpandedIds((current) => new Set(current).add(parentId));
        } catch {
            setError('Could not load replies. Try again.');
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders, expandedIds, postId, repliesByParent]);

    const submitComment = useCallback(async () => {
        const body = draft.trim();
        if (!body || submitting || !accessToken) return;

        setSubmitting(true);
        setError(null);
        const parentId = replyTo?.id ?? null;

        try {
            const response = await fetch(`/api/showcase/posts/${encodeURIComponent(postId)}/comments`, {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify({ body, parentId }),
            });
            const data = await response.json() as { comment?: PostComment; commentCount?: number; error?: string };
            if (!response.ok || !data.comment) {
                throw new Error(data.error || 'Could not post comment');
            }

            setDraft('');
            setReplyTo(null);

            if (parentId) {
                setRepliesByParent((current) => ({
                    ...current,
                    [parentId]: [...(current[parentId] ?? []), data.comment as PostComment],
                }));
                setComments((current) => adjustReplyCount(current, parentId, 1));
                setExpandedIds((current) => new Set(current).add(parentId));
            } else {
                setComments((current) => prependComment(current, data.comment as PostComment));
            }

            publishCount(data.commentCount ?? totalCount + 1);
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Could not post comment.');
        } finally {
            setSubmitting(false);
        }
    }, [accessToken, authHeaders, draft, postId, publishCount, replyTo, submitting, totalCount]);

    const removeComment = useCallback(async (comment: PostComment, asOwner: boolean) => {
        const confirmed = window.confirm(asOwner
            ? 'Remove this comment? It will be hidden from everyone viewing your post.'
            : 'Delete your comment? It will be replaced with “[deleted]”. Replies to it stay visible.');
        if (!confirmed) return;

        setBusyCommentId(comment.id);
        setError(null);
        try {
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(comment.id)}`,
                { method: 'DELETE', headers: authHeaders() }
            );
            const data = await response.json() as { status?: PostComment['status']; commentCount?: number; error?: string };
            if (!response.ok || !data.status) {
                throw new Error(data.error || 'Could not remove comment');
            }

            if (comment.parentId) {
                setRepliesByParent((current) => ({
                    ...current,
                    [comment.parentId as string]: markCommentRemoved(
                        current[comment.parentId as string] ?? [],
                        comment.id,
                        data.status as PostComment['status']
                    ),
                }));
                setComments((current) => adjustReplyCount(current, comment.parentId as string, -1));
            } else {
                setComments((current) => markCommentRemoved(current, comment.id, data.status as PostComment['status']));
            }

            publishCount(data.commentCount ?? Math.max(0, totalCount - 1));
        } catch (removeError) {
            setError(removeError instanceof Error ? removeError.message : 'Could not remove comment.');
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders, postId, publishCount, totalCount]);

    const reportComment = useCallback(async (comment: PostComment) => {
        if (!window.confirm('Report this comment? Magicbooklet will send it to the moderation team.')) return;

        setBusyCommentId(comment.id);
        try {
            const response = await fetch('/api/moderation/reports', {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify({
                    targetType: 'comment',
                    targetId: comment.id,
                    sourceSurface: 'comments',
                    reason: 'harassment',
                }),
            });
            if (!response.ok) throw new Error('Could not report comment');
            setError(null);
            window.alert('Thanks for the report. Our moderation team will take a look.');
        } catch {
            setError('Could not report that comment. Try again.');
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders]);

    const rows = useMemo(
        () => buildCommentThreads({ topLevel: comments, repliesByParent, expandedIds }),
        [comments, expandedIds, repliesByParent]
    );

    const canSubmit = draft.trim().length > 0 && !submitting && Boolean(accessToken);

    return (
        <section className="flex flex-col gap-4" aria-label="Comments">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-[var(--ui-text-primary)]">
                    {totalCount > 0 ? `${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}` : 'Comments'}
                </h2>
                <div className="flex items-center gap-1 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] p-1">
                    {SORTS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => setSort(option.id)}
                            aria-pressed={sort === option.id}
                            className={`ui-focus-ring min-h-8 rounded-full px-3 text-xs font-bold transition ${
                                sort === option.id
                                    ? 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                                    : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                            }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {user ? (
                <div className="flex flex-col gap-2">
                    {replyTo ? (
                        <div className="flex items-center gap-2 text-xs text-[var(--ui-text-muted)]">
                            <span className="truncate">{`Replying to ${getCommentDisplay(replyTo).authorLabel}`}</span>
                            <button
                                type="button"
                                onClick={() => setReplyTo(null)}
                                className="ui-focus-ring rounded-sm font-bold text-[var(--ui-primary)] hover:underline"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : null}
                    <div className="flex items-start gap-3">
                        <PostCommentAvatar
                            avatarUrl={(user.user_metadata?.avatar_url as string | undefined) ?? null}
                            name={(user.user_metadata?.full_name as string | undefined) || user.email || 'You'}
                        />
                        <div className="flex-1">
                            <textarea
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                maxLength={POST_COMMENT_MAX_LENGTH}
                                rows={replyTo || draft ? 3 : 1}
                                placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'}
                                aria-label={replyTo ? 'Write a reply' : 'Write a comment'}
                                className="ui-focus-ring w-full resize-y rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-sm leading-6 text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]"
                            />
                            <div className="mt-2 flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => void submitComment()}
                                    disabled={!canSubmit}
                                    className="ui-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
                                >
                                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                    {replyTo ? 'Reply' : 'Comment'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <Link
                    href="/login"
                    className="ui-focus-ring flex min-h-12 items-center gap-2 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-strong)]"
                >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Sign in to join the conversation
                </Link>
            )}

            {error ? (
                <p role="alert" className="rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]">
                    {error}
                </p>
            ) : null}

            {rows.length === 0 && !loading ? (
                <p className="rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-6 text-center text-sm text-[var(--ui-text-muted)]">
                    No comments yet. Be the first to share what you think.
                </p>
            ) : (
                <ol className="flex flex-col">
                    {rows.map((row) => {
                        if (row.kind === 'replies-toggle') {
                            return (
                                <li key={row.key} className="pl-10">
                                    <button
                                        type="button"
                                        onClick={() => row.parentId && void toggleReplies(row.parentId)}
                                        aria-expanded={row.expanded}
                                        className="ui-focus-ring inline-flex min-h-9 items-center gap-2 rounded-sm text-xs font-bold text-[var(--ui-primary)] hover:underline"
                                    >
                                        {busyCommentId === row.parentId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                        {row.expanded
                                            ? 'Hide replies'
                                            : `View ${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'}`}
                                    </button>
                                </li>
                            );
                        }

                        const comment = row.comment as PostComment;
                        const display = getCommentDisplay(comment);
                        const isReply = row.kind === 'reply';

                        return (
                            <li
                                key={row.key}
                                className={isReply
                                    // The rule is Reddit's thread line: it makes depth readable
                                    // without indenting far enough to squeeze the text column.
                                    ? 'ml-3.5 border-l border-[var(--ui-border-subtle)] pl-6 py-2.5'
                                    : 'py-2.5'}
                            >
                                <div className="flex items-start gap-3">
                                    <PostCommentAvatar
                                        avatarUrl={comment.author?.avatarUrl ?? null}
                                        name={display.authorLabel}
                                        size={isReply ? 24 : 28}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            {display.authorHref ? (
                                                <Link
                                                    href={display.authorHref}
                                                    prefetch={false}
                                                    className="ui-focus-ring rounded-sm font-bold text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]"
                                                >
                                                    {display.authorLabel}
                                                </Link>
                                            ) : (
                                                <span className="font-bold text-[var(--ui-text-secondary)]">{display.authorLabel}</span>
                                            )}
                                            <span className="text-[var(--ui-text-faint)]">
                                                {formatRelativeTime(comment.createdAt)}
                                            </span>
                                        </div>
                                        <p className={`mt-1 whitespace-pre-wrap text-sm leading-6 ${
                                            display.isDeleted
                                                ? 'italic text-[var(--ui-text-faint)]'
                                                : 'text-[var(--ui-text-primary)]'
                                        }`}>
                                            {display.bodyText}
                                        </p>
                                        {display.isDeleted ? null : (
                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                <CommentAction
                                                    label="Reply"
                                                    onClick={() => setReplyTo(comment)}
                                                />
                                                {canDeleteComment(comment, user?.id) ? (
                                                    <CommentAction
                                                        label="Delete"
                                                        icon={<Trash2 className="h-3.5 w-3.5" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, false)}
                                                    />
                                                ) : null}
                                                {canRemoveComment(comment, resolvedCreatorId, user?.id) ? (
                                                    <CommentAction
                                                        label="Remove"
                                                        icon={<Trash2 className="h-3.5 w-3.5" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, true)}
                                                    />
                                                ) : null}
                                                {canReportComment(comment, user?.id) ? (
                                                    <CommentAction
                                                        label="Report"
                                                        icon={<Flag className="h-3.5 w-3.5" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void reportComment(comment)}
                                                    />
                                                ) : null}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}

            {loading ? (
                <p className="flex items-center justify-center gap-2 py-3 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading comments…
                </p>
            ) : nextOffset !== null && rows.length > 0 ? (
                <button
                    type="button"
                    onClick={() => void loadPage(nextOffset, false)}
                    className="ui-focus-ring min-h-11 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-strong)]"
                >
                    Load more comments
                </button>
            ) : null}
        </section>
    );
}

function CommentAction({
    label,
    icon,
    busy,
    onClick,
}: {
    label: string;
    icon?: React.ReactNode;
    busy?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={busy}
            className="ui-focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-full px-2 text-xs font-bold text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-secondary)] disabled:opacity-60"
        >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
            {label}
        </button>
    );
}
