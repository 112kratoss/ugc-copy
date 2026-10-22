'use client';

import { Flag, Loader2, MessageSquare, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PostCommentAvatar from '@/components/PostCommentAvatar';
import { useAuth } from '@/components/AuthProvider';
import { useConfirmation } from '@/components/useConfirmation';
import {
    POST_COMMENT_MAX_LENGTH,
    POST_COMMENTS_MAX_PAGE_SIZE,
    POST_COMMENTS_PAGE_SIZE,
    adjustReplyCount,
    buildCommentThreads,
    buildCommentsQuery,
    canDeleteComment,
    canRemoveComment,
    canReportComment,
    describeCommentRequestFailure,
    getCommentDisplay,
    markCommentRemoved,
    mergeCommentPage,
    prependComment,
    withPendingComments,
    type CommentRequestFailure,
    type CommentRequestKind,
    type PostComment,
    type PostCommentSort,
    type PostCommentsPage,
} from '@/lib/post-comments-client';
import { formatRelativeTime } from '@/lib/post-feed-presentation';
import { getCurrentInternalPath } from '@/lib/share';

const SORTS: Array<{ id: PostCommentSort; label: string }> = [
    { id: 'top', label: 'Top' },
    { id: 'newest', label: 'New' },
];

const REPORT_REASONS = [
    { value: 'spam', label: 'Spam' },
    { value: 'harassment', label: 'Harassment' },
    { value: 'unsafe_content', label: 'Unsafe content' },
    { value: 'other', label: 'Other' },
] as const;

type ReportReason = (typeof REPORT_REASONS)[number]['value'];

/**
 * One read of a comment list: the top level, or one comment's replies. A read
 * that fails is kept so Retry repeats it instead of starting the list over.
 */
type ListRead =
    | { kind: 'first-page' }
    | { kind: 'next-page'; offset: number }
    // After a mutation: everything loaded so far, read again from the top,
    // because a new or removed comment moves every later offset.
    | { kind: 'loaded-range'; count: number };

interface ReplyPageState {
    hasLoaded: boolean;
    loading: boolean;
    nextOffset: number | null;
    error: CommentRequestFailure | null;
    failedRead: ListRead | null;
}

interface PostCommentsProps {
    postId: string;
    postCreatorId: string | null;
    commentCount: number;
    onCommentCountChange?: (commentCount: number) => void;
    /**
     * The feed delivery the thread was opened from, sent with each new comment
     * so the server can credit it to the ranked card that showed the post.
     * Absent wherever the post was not reached through a ranked feed.
     */
    deliveryId?: string | null;
}

function emptyReplyPageState(): ReplyPageState {
    return {
        hasLoaded: false,
        loading: false,
        nextOffset: 0,
        error: null,
        failedRead: null,
    };
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

/** Carries the reader-facing failure of an answered request to its catch. */
class CommentRequestError extends Error {
    readonly failure: CommentRequestFailure;

    constructor(failure: CommentRequestFailure) {
        super(failure.message);
        this.name = 'CommentRequestError';
        this.failure = failure;
    }
}

function toFailure(kind: CommentRequestKind, error: unknown): CommentRequestFailure {
    return error instanceof CommentRequestError
        ? error.failure
        : describeCommentRequestFailure(kind, null);
}

type CommentErrorBody = { error?: unknown; retryAfterSeconds?: unknown };

export default function PostComments({
    postId,
    postCreatorId,
    commentCount,
    onCommentCountChange,
    deliveryId = null,
}: PostCommentsProps) {
    const { session, user } = useAuth();
    const accessToken = session?.access_token ?? null;
    const viewerId = user?.id ?? null;
    const askToConfirm = useConfirmation();

    const [sort, setSort] = useState<PostCommentSort>('top');
    const [comments, setComments] = useState<PostComment[]>([]);
    // The viewer's own comments and replies posted while the thread is open,
    // kept on screen until a server read returns them.
    const [pendingComments, setPendingComments] = useState<PostComment[]>([]);
    const [repliesByParent, setRepliesByParent] = useState<Record<string, PostComment[]>>({});
    const [pendingRepliesByParent, setPendingRepliesByParent] = useState<Record<string, PostComment[]>>({});
    const [replyPages, setReplyPages] = useState<Record<string, ReplyPageState>>({});
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [nextOffset, setNextOffset] = useState<number | null>(0);
    const [resolvedCreatorId, setResolvedCreatorId] = useState(postCreatorId);
    const [totalCount, setTotalCount] = useState(commentCount);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<CommentRequestFailure | null>(null);
    const [actionError, setActionError] = useState<CommentRequestFailure | null>(null);
    const [statusMessage, setStatusMessage] = useState('');
    const [draft, setDraft] = useState('');
    const [replyTo, setReplyTo] = useState<PostComment | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [busyCommentId, setBusyCommentId] = useState<string | null>(null);
    const [reportTarget, setReportTarget] = useState<PostComment | null>(null);
    const [reportReason, setReportReason] = useState<ReportReason>('spam');
    const [reportDetails, setReportDetails] = useState('');
    const [loginHref, setLoginHref] = useState(
        `/login?returnUrl=${encodeURIComponent(`/showcase/${postId}`)}`
    );

    const topLevelAbortRef = useRef<AbortController | null>(null);
    const topLevelRequestIdRef = useRef(0);
    const replyRequestIdsRef = useRef<Record<string, number>>({});
    const failedReadRef = useRef<ListRead | null>(null);
    // The lists as last rendered. A mutation sizes its re-read from them; its
    // own local patch is still queued when the re-read starts.
    const commentsRef = useRef(comments);
    const repliesByParentRef = useRef(repliesByParent);
    // Requests read the token when they are sent. Supabase refreshes it about
    // hourly and when a backgrounded tab wakes; the viewer is the same, so the
    // thread must not start over.
    const authRef = useRef({ accessToken, viewerId });
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const reportReasonRef = useRef<HTMLSelectElement | null>(null);
    const reportOpenerRef = useRef<HTMLButtonElement | null>(null);

    const authHeaders = useCallback((json = false) => {
        const headers: Record<string, string> = {};
        if (json) headers['Content-Type'] = 'application/json';
        const token = authRef.current.accessToken;
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }, []);

    useEffect(() => {
        commentsRef.current = comments;
    }, [comments]);

    useEffect(() => {
        repliesByParentRef.current = repliesByParent;
    }, [repliesByParent]);

    // Callers pass an inline arrow, so this callback has a new identity on every
    // render. Holding it in a ref keeps request callbacks stable.
    const onCommentCountChangeRef = useRef(onCommentCountChange);
    useEffect(() => {
        onCommentCountChangeRef.current = onCommentCountChange;
    }, [onCommentCountChange]);

    const publishCount = useCallback((next: number) => {
        const normalized = Math.max(0, next);
        setTotalCount(normalized);
        onCommentCountChangeRef.current?.(normalized);
    }, []);

    const readList = useCallback(async (
        parentId: string | null,
        read: ListRead,
        signal?: AbortSignal
    ): Promise<{ page: PostCommentsPage; comments: PostComment[] }> => {
        const kind: CommentRequestKind = parentId ? 'replies' : 'load';
        const fetchPage = async (offset: number, limit: number) => {
            // Replies are always oldest first; only the top level has a sort.
            const query = buildCommentsQuery(parentId
                ? { parentId, offset, limit }
                : { offset, limit, sort });
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments?${query}`,
                { headers: authHeaders(), signal }
            );
            if (!response.ok) {
                const body = await response.json().catch(() => null) as CommentErrorBody | null;
                throw new CommentRequestError(
                    describeCommentRequestFailure(kind, response.status, body)
                );
            }
            return await response.json() as PostCommentsPage;
        };

        if (read.kind !== 'loaded-range') {
            const page = await fetchPage(
                read.kind === 'next-page' ? read.offset : 0,
                POST_COMMENTS_PAGE_SIZE
            );
            return { page, comments: page.comments };
        }

        // The server answers at most 50 comments a read, and its nextOffset is
        // a raw row offset past rows hidden from this viewer, so the reads
        // chain on it exactly as "Load more" does.
        const target = Math.max(read.count, POST_COMMENTS_PAGE_SIZE);
        let received: PostComment[] = [];
        let offset = 0;
        for (;;) {
            const page = await fetchPage(
                offset,
                Math.min(target - received.length, POST_COMMENTS_MAX_PAGE_SIZE)
            );
            received = mergeCommentPage(received, page.comments);
            const { hasMore, nextOffset: pageNextOffset } = page.pageInfo;
            if (
                received.length >= target
                || !hasMore
                || pageNextOffset === null
                || pageNextOffset <= offset
            ) {
                return { page, comments: received };
            }
            offset = pageNextOffset;
        }
    }, [authHeaders, postId, sort]);

    const readTopLevel = useCallback(async (read: ListRead) => {
        const requestId = ++topLevelRequestIdRef.current;
        topLevelAbortRef.current?.abort();
        const controller = new AbortController();
        topLevelAbortRef.current = controller;
        failedReadRef.current = null;

        setLoading(true);
        setLoadError(null);

        try {
            const { page, comments: incoming } = await readList(null, read, controller.signal);
            if (requestId !== topLevelRequestIdRef.current) return;

            // Only "Load more" adds to the list. A first page, or the loaded
            // range read again, is the whole list as the server now has it.
            setComments((current) => mergeCommentPage(
                current,
                incoming,
                read.kind !== 'next-page'
            ));
            setNextOffset(page.pageInfo.hasMore ? page.pageInfo.nextOffset : null);
            setResolvedCreatorId(page.postCreatorId ?? postCreatorId);
            setHasLoaded(true);
            publishCount(page.commentCount);
        } catch (error) {
            if (isAbortError(error) || requestId !== topLevelRequestIdRef.current) return;
            failedReadRef.current = read;
            setHasLoaded(true);
            setLoadError(toFailure('load', error));
        } finally {
            if (requestId === topLevelRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, [postCreatorId, publishCount, readList]);

    const readReplies = useCallback(async (parentId: string, read: ListRead) => {
        const requestId = (replyRequestIdsRef.current[parentId] ?? 0) + 1;
        replyRequestIdsRef.current[parentId] = requestId;
        setReplyPages((current) => ({
            ...current,
            [parentId]: {
                ...(current[parentId] ?? emptyReplyPageState()),
                loading: true,
                error: null,
                failedRead: null,
            },
        }));

        try {
            const { page, comments: incoming } = await readList(parentId, read);
            if (replyRequestIdsRef.current[parentId] !== requestId) return;

            setRepliesByParent((current) => ({
                ...current,
                [parentId]: mergeCommentPage(
                    current[parentId] ?? [],
                    incoming,
                    read.kind !== 'next-page'
                ),
            }));
            setReplyPages((current) => ({
                ...current,
                [parentId]: {
                    hasLoaded: true,
                    loading: false,
                    nextOffset: page.pageInfo.hasMore ? page.pageInfo.nextOffset : null,
                    error: null,
                    failedRead: null,
                },
            }));
        } catch (error) {
            if (replyRequestIdsRef.current[parentId] !== requestId) return;
            setReplyPages((current) => ({
                ...current,
                [parentId]: {
                    ...(current[parentId] ?? emptyReplyPageState()),
                    loading: false,
                    error: toFailure('replies', error),
                    failedRead: read,
                },
            }));
        }
    }, [readList]);

    // Declared before the reset below so a new viewer's first read already
    // carries their token. For the same viewer a new token changes nothing on
    // screen; only a failed read is tried again with it, because a read sent
    // with a token that expired on the way fails and the refresh is its one
    // useful retry.
    useEffect(() => {
        const previous = authRef.current;
        authRef.current = { accessToken, viewerId };
        const failedRead = failedReadRef.current;
        if (
            failedRead
            && accessToken
            && previous.accessToken !== accessToken
            && previous.viewerId === viewerId
        ) {
            void readTopLevel(failedRead);
        }
    }, [accessToken, readTopLevel, viewerId]);

    // A different viewer (sign-in, sign-out, another account) or another sort
    // needs a clean first page: which comments a viewer may see depends on
    // their blocks. Aborting the previous request keeps an older sort from
    // overwriting the current selection.
    useEffect(() => {
        const replyRequestIds = replyRequestIdsRef.current;
        setComments([]);
        setPendingComments([]);
        setRepliesByParent({});
        setPendingRepliesByParent({});
        setReplyPages({});
        setExpandedIds(new Set());
        setNextOffset(0);
        setResolvedCreatorId(postCreatorId);
        setHasLoaded(false);
        setLoadError(null);
        setActionError(null);
        void readTopLevel({ kind: 'first-page' });

        return () => {
            topLevelRequestIdRef.current += 1;
            topLevelAbortRef.current?.abort();
            topLevelAbortRef.current = null;
            for (const parentId of Object.keys(replyRequestIds)) {
                replyRequestIds[parentId] += 1;
            }
        };
    }, [postCreatorId, postId, readTopLevel, viewerId]);

    useEffect(() => {
        setTotalCount(commentCount);
    }, [commentCount, postId]);

    useEffect(() => {
        setDraft('');
        setReplyTo(null);
        setReportTarget(null);
        setReportDetails('');
        setReportReason('spam');
        setStatusMessage('');
    }, [postId]);

    useEffect(() => {
        const returnPath = getCurrentInternalPath(`/showcase/${postId}`);
        setLoginHref(`/login?returnUrl=${encodeURIComponent(returnPath)}`);
    }, [postId]);

    useEffect(() => {
        if (reportTarget) {
            window.requestAnimationFrame(() => reportReasonRef.current?.focus());
            return;
        }
        // The form opens at the top of the thread. Closing it (Cancel, or a
        // sent report) puts focus back on the Report button it came from, so a
        // keyboard or screen-reader user keeps their place.
        const opener = reportOpenerRef.current;
        reportOpenerRef.current = null;
        if (!opener) return;
        window.requestAnimationFrame(() => {
            if (opener.isConnected) opener.focus();
        });
    }, [reportTarget]);

    const retryFailedRead = useCallback(() => {
        void readTopLevel(failedReadRef.current ?? { kind: 'first-page' });
    }, [readTopLevel]);

    const toggleReplies = useCallback(async (parentId: string) => {
        if (expandedIds.has(parentId)) {
            setExpandedIds((current) => {
                const next = new Set(current);
                next.delete(parentId);
                return next;
            });
            return;
        }

        setExpandedIds((current) => new Set(current).add(parentId));
        if (!replyPages[parentId]?.hasLoaded) {
            await readReplies(parentId, { kind: 'first-page' });
        }
    }, [expandedIds, readReplies, replyPages]);

    const submitComment = useCallback(async () => {
        const body = draft.trim();
        if (!body || submitting || !accessToken) return;

        setSubmitting(true);
        setActionError(null);
        setStatusMessage('');
        // Be defensive if a stale client ever supplies a reply as the target:
        // the product supports one reply level, so normalize to the root.
        const parentId = replyTo?.parentId ?? replyTo?.id ?? null;
        const kind: CommentRequestKind = parentId ? 'reply' : 'post';

        try {
            const response = await fetch(`/api/showcase/posts/${encodeURIComponent(postId)}/comments`, {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify({ body, parentId, ...(deliveryId ? { deliveryId } : {}) }),
            });
            // A gateway's error page is not JSON, and its parse error is no
            // message for a reader.
            const data = await response.json().catch(() => ({})) as CommentErrorBody & {
                comment?: PostComment;
                commentCount?: number;
            };
            if (!response.ok || !data.comment) {
                throw new CommentRequestError(
                    describeCommentRequestFailure(kind, response.status, data)
                );
            }
            const posted = data.comment;

            setDraft('');
            setReplyTo(null);

            let loadedCount = commentsRef.current.length;
            if (parentId) {
                setComments((current) => adjustReplyCount(current, parentId, 1));
                setExpandedIds((current) => new Set(current).add(parentId));
                setPendingRepliesByParent((current) => ({
                    ...current,
                    [parentId]: mergeCommentPage(current[parentId] ?? [], [posted]),
                }));
            } else {
                setComments((current) => prependComment(current, posted));
                setPendingComments((current) => prependComment(current, posted));
                loadedCount += 1;
            }

            publishCount(data.commentCount ?? totalCount + 1);
            setStatusMessage(parentId ? 'Reply posted.' : 'Comment posted.');
            composerRef.current?.focus();

            // A new comment, or under Top a parent's new reply count, moves the
            // offsets of everything after it. Reading the loaded range again
            // keeps every page the reader opened and lets "Load more" continue
            // without skipping or repeating a comment. A reply is the newest in
            // its thread, so loaded replies keep their offsets; they are read
            // only when this reply is what opened them.
            const refreshes = [readTopLevel({ kind: 'loaded-range', count: loadedCount })];
            if (parentId && !replyPages[parentId]?.hasLoaded) {
                refreshes.push(readReplies(parentId, { kind: 'first-page' }));
            }
            await Promise.all(refreshes);
        } catch (submitError) {
            setActionError(toFailure(kind, submitError));
        } finally {
            setSubmitting(false);
        }
    }, [
        accessToken,
        authHeaders,
        deliveryId,
        draft,
        postId,
        publishCount,
        readReplies,
        readTopLevel,
        replyPages,
        replyTo,
        submitting,
        totalCount,
    ]);

    const removeComment = useCallback(async (comment: PostComment, asOwner: boolean) => {
        // A removed comment keeps a "[deleted]" row only while it holds
        // replies; without replies it is simply gone.
        const confirmed = await askToConfirm(asOwner
            ? {
                title: 'Remove this comment?',
                message: 'It will be hidden from everyone viewing your post.',
                confirmLabel: 'Remove comment',
                tone: 'danger',
            }
            : {
                title: 'Delete your comment?',
                message: comment.replyCount > 0
                    ? 'It will be replaced with “[deleted]”. Replies to it stay visible.'
                    : 'It will be removed from this post.',
                confirmLabel: 'Delete comment',
                tone: 'danger',
            });
        if (!confirmed) return;

        setBusyCommentId(comment.id);
        setActionError(null);
        setStatusMessage('');
        try {
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(comment.id)}`,
                { method: 'DELETE', headers: authHeaders() }
            );
            // Not JSON from a gateway: see submitComment.
            const data = await response.json().catch(() => ({})) as CommentErrorBody & {
                status?: PostComment['status'];
                commentCount?: number;
            };
            if (!response.ok || !data.status) {
                throw new CommentRequestError(
                    describeCommentRequestFailure('remove', response.status, data)
                );
            }
            const status = data.status;
            const parentId = comment.parentId;

            let loadedCount = commentsRef.current.length;
            let loadedReplyCount = 0;
            if (parentId) {
                loadedReplyCount = markCommentRemoved(
                    repliesByParentRef.current[parentId] ?? [],
                    comment.id,
                    status
                ).length;
                setRepliesByParent((current) => ({
                    ...current,
                    [parentId]: markCommentRemoved(current[parentId] ?? [], comment.id, status),
                }));
                setPendingRepliesByParent((current) => ({
                    ...current,
                    [parentId]: (current[parentId] ?? []).filter((reply) => reply.id !== comment.id),
                }));
                setComments((current) => adjustReplyCount(current, parentId, -1));
            } else {
                loadedCount = markCommentRemoved(commentsRef.current, comment.id, status).length;
                setComments((current) => markCommentRemoved(current, comment.id, status));
                setPendingComments((current) => current.filter((item) => item.id !== comment.id));
            }

            publishCount(data.commentCount ?? Math.max(0, totalCount - 1));
            setStatusMessage(asOwner ? 'Comment removed.' : 'Comment deleted.');

            // A removal moves every later offset; read the loaded range again,
            // for the same reasons as after a post.
            const refreshes = [readTopLevel({ kind: 'loaded-range', count: loadedCount })];
            if (parentId && replyPages[parentId]?.hasLoaded) {
                refreshes.push(readReplies(parentId, { kind: 'loaded-range', count: loadedReplyCount }));
            }
            await Promise.all(refreshes);
        } catch (removeError) {
            setActionError(toFailure('remove', removeError));
        } finally {
            setBusyCommentId(null);
        }
    }, [askToConfirm, authHeaders, postId, publishCount, readReplies, readTopLevel, replyPages, totalCount]);

    const submitReport = useCallback(async () => {
        if (!reportTarget || busyCommentId) return;

        setBusyCommentId(reportTarget.id);
        setActionError(null);
        setStatusMessage('');
        try {
            const response = await fetch('/api/moderation/reports', {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify({
                    targetType: 'comment',
                    targetId: reportTarget.id,
                    sourceSurface: 'comments',
                    reason: reportReason,
                    details: reportDetails.trim() || undefined,
                }),
            });
            const data = await response.json().catch(() => null) as CommentErrorBody | null;
            if (!response.ok) {
                throw new CommentRequestError(
                    describeCommentRequestFailure('report', response.status, data)
                );
            }

            setReportTarget(null);
            setReportDetails('');
            setReportReason('spam');
            setStatusMessage('Report submitted for review.');
        } catch (reportError) {
            setActionError(toFailure('report', reportError));
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders, busyCommentId, reportDetails, reportReason, reportTarget]);

    const topLevelForDisplay = useMemo(
        () => withPendingComments(comments, pendingComments, 'first'),
        [comments, pendingComments]
    );
    const repliesForDisplay = useMemo(() => {
        const merged = { ...repliesByParent };
        for (const [parentId, pending] of Object.entries(pendingRepliesByParent)) {
            merged[parentId] = withPendingComments(repliesByParent[parentId] ?? [], pending, 'last');
        }
        return merged;
    }, [pendingRepliesByParent, repliesByParent]);
    const rows = useMemo(
        () => buildCommentThreads({
            topLevel: topLevelForDisplay,
            repliesByParent: repliesForDisplay,
            expandedIds,
        }),
        [expandedIds, repliesForDisplay, topLevelForDisplay]
    );

    const canSubmit = draft.trim().length > 0 && !submitting && Boolean(accessToken);
    const showInitialLoading = loading && !hasLoaded && rows.length === 0;
    const showEmpty = hasLoaded
        && rows.length === 0
        && nextOffset === null
        && !loadError;

    return (
        <section
            id={`comments-${postId}`}
            className="flex flex-col gap-4"
            aria-label="Comments"
            aria-busy={loading}
        >
            <p className="sr-only" role="status" aria-live="polite">{statusMessage}</p>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-[var(--ui-text-primary)]">
                    {totalCount > 0
                        ? `${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}`
                        : 'Comments'}
                </h2>
                {/* Sorting nothing is noise — the pills appear with the first comment. */}
                {totalCount > 0 ? (
                <div
                    className="flex items-center gap-1 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] p-1"
                    role="group"
                    aria-label="Sort comments"
                >
                    {SORTS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => setSort(option.id)}
                            aria-pressed={sort === option.id}
                            className={`ui-focus-ring min-h-11 rounded-full px-4 text-xs font-bold transition ${
                                sort === option.id
                                    ? 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                                    : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                            }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                ) : null}
            </div>

            {user ? (
                <div className="flex flex-col gap-2">
                    {replyTo ? (
                        <div className="flex items-center justify-between gap-2 text-xs text-[var(--ui-text-muted)]">
                            <span className="truncate">
                                {`Replying to ${getCommentDisplay(replyTo).authorLabel}`}
                            </span>
                            <button
                                type="button"
                                onClick={() => setReplyTo(null)}
                                className="ui-focus-ring min-h-11 rounded-full px-3 font-bold text-[var(--ui-primary)] hover:bg-[var(--ui-surface-2)]"
                            >
                                Cancel reply
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
                                ref={composerRef}
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
                                    className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
                                >
                                    {submitting
                                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                        : null}
                                    {replyTo ? 'Reply' : 'Comment'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <Link
                    href={loginHref}
                    className="ui-focus-ring flex min-h-12 items-center gap-2 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-strong)]"
                >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Sign in to join the conversation
                </Link>
            )}

            {reportTarget ? (
                <div
                    role="dialog"
                    aria-labelledby={`report-comment-${reportTarget.id}`}
                    className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] p-4"
                >
                    <h3
                        id={`report-comment-${reportTarget.id}`}
                        className="text-sm font-bold text-[var(--ui-text-primary)]"
                    >
                        Report this comment
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]">
                        Choose the closest reason so the moderation team can review it correctly.
                    </p>
                    <label className="mt-3 block text-xs font-bold text-[var(--ui-text-secondary)]">
                        Reason
                        <select
                            ref={reportReasonRef}
                            value={reportReason}
                            onChange={(event) => setReportReason(event.target.value as ReportReason)}
                            className="ui-focus-ring mt-1 min-h-11 w-full rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 text-sm text-[var(--ui-text-primary)]"
                        >
                            {REPORT_REASONS.map((reason) => (
                                <option key={reason.value} value={reason.value}>{reason.label}</option>
                            ))}
                        </select>
                    </label>
                    <label className="mt-3 block text-xs font-bold text-[var(--ui-text-secondary)]">
                        Details <span className="font-medium text-[var(--ui-text-faint)]">(optional)</span>
                        <textarea
                            value={reportDetails}
                            onChange={(event) => setReportDetails(event.target.value)}
                            rows={2}
                            maxLength={1000}
                            className="ui-focus-ring mt-1 w-full resize-y rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2 text-sm text-[var(--ui-text-primary)]"
                        />
                    </label>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setReportTarget(null);
                                setReportDetails('');
                                setReportReason('spam');
                            }}
                            className="ui-focus-ring min-h-11 rounded-full px-4 text-sm font-bold text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-3)]"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void submitReport()}
                            disabled={busyCommentId === reportTarget.id}
                            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] disabled:opacity-60"
                        >
                            {busyCommentId === reportTarget.id
                                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                : <Flag className="h-4 w-4" aria-hidden="true" />}
                            Submit report
                        </button>
                    </div>
                </div>
            ) : null}

            {actionError ? (
                <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]"
                >
                    <span>{actionError.message}</span>
                    <div className="flex flex-wrap items-center gap-1">
                        {actionError.signIn ? <SignInLink href={loginHref} /> : null}
                        <button
                            type="button"
                            onClick={() => setActionError(null)}
                            className="ui-focus-ring min-h-11 rounded-full px-3 text-xs font-bold hover:bg-white/5"
                        >
                            Dismiss
                        </button>
                    </div>
                </div>
            ) : null}

            {loadError ? (
                <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]"
                >
                    <span>{loadError.message}</span>
                    {loadError.signIn || loadError.retryable ? (
                        <div className="flex flex-wrap items-center gap-2">
                            {loadError.signIn ? <SignInLink href={loginHref} /> : null}
                            {loadError.retryable ? (
                                <button
                                    type="button"
                                    onClick={retryFailedRead}
                                    className="ui-focus-ring min-h-11 rounded-full border border-current px-4 text-xs font-bold"
                                >
                                    Retry
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showInitialLoading ? (
                <p className="flex min-h-24 items-center justify-center gap-2 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading comments…
                </p>
            ) : null}

            {showEmpty ? (
                <p className="rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-6 text-center text-sm text-[var(--ui-text-muted)]">
                    No comments yet. Be the first to share what you think.
                </p>
            ) : null}

            {rows.length > 0 ? (
                <ol className="flex flex-col" aria-label="Comment thread">
                    {rows.map((row) => {
                        if (row.kind === 'replies-toggle') {
                            const parentId = row.parentId as string;
                            const replyPage = replyPages[parentId] ?? emptyReplyPageState();
                            return (
                                <li key={row.key} className="pl-10">
                                    <div className="flex flex-wrap items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => void toggleReplies(parentId)}
                                            aria-expanded={row.expanded}
                                            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold text-[var(--ui-primary)] hover:bg-[var(--ui-surface-2)]"
                                        >
                                            {replyPage.loading && !replyPage.hasLoaded
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                : null}
                                            {row.expanded
                                                ? 'Hide replies'
                                                : `View ${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'}`}
                                        </button>
                                        {row.expanded && replyPage.nextOffset !== null && replyPage.hasLoaded ? (
                                            <button
                                                type="button"
                                                onClick={() => void readReplies(parentId, {
                                                    kind: 'next-page',
                                                    offset: replyPage.nextOffset as number,
                                                })}
                                                disabled={replyPage.loading}
                                                className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] disabled:opacity-60"
                                            >
                                                {replyPage.loading
                                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                    : null}
                                                Load more replies
                                            </button>
                                        ) : null}
                                    </div>
                                    {row.expanded && replyPage.error ? (
                                        <div className="flex flex-wrap items-center gap-2 pb-2 text-xs text-[#ff7c8b]">
                                            <span>{replyPage.error.message}</span>
                                            {replyPage.error.signIn ? <SignInLink href={loginHref} /> : null}
                                            {replyPage.error.retryable ? (
                                                <button
                                                    type="button"
                                                    onClick={() => void readReplies(
                                                        parentId,
                                                        replyPage.failedRead ?? { kind: 'first-page' }
                                                    )}
                                                    className="ui-focus-ring min-h-11 rounded-full px-3 font-bold hover:bg-[var(--ui-surface-2)]"
                                                >
                                                    Retry replies
                                                </button>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </li>
                            );
                        }

                        const comment = row.comment as PostComment;
                        const display = getCommentDisplay(comment);
                        const isReply = row.kind === 'reply';

                        return (
                            <li
                                key={row.key}
                                aria-label={isReply ? `Reply from ${display.authorLabel}` : undefined}
                                aria-level={isReply ? 2 : 1}
                                className={isReply
                                    ? 'ml-3.5 border-l border-[var(--ui-border-subtle)] py-2.5 pl-6'
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
                                                <span className="font-bold text-[var(--ui-text-secondary)]">
                                                    {display.authorLabel}
                                                </span>
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
                                                {user && !isReply ? (
                                                    <CommentAction
                                                        label="Reply"
                                                        accessibleLabel={`Reply to ${display.authorLabel}`}
                                                        onClick={() => {
                                                            setReplyTo(comment);
                                                            window.requestAnimationFrame(() => {
                                                                composerRef.current?.focus();
                                                            });
                                                        }}
                                                    />
                                                ) : null}
                                                {canDeleteComment(comment, user?.id) ? (
                                                    <CommentAction
                                                        label="Delete"
                                                        accessibleLabel="Delete your comment"
                                                        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, false)}
                                                    />
                                                ) : null}
                                                {canRemoveComment(comment, resolvedCreatorId, user?.id) ? (
                                                    <CommentAction
                                                        label="Remove"
                                                        accessibleLabel={`Remove ${display.authorLabel}'s comment`}
                                                        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, true)}
                                                    />
                                                ) : null}
                                                {canReportComment(comment, user?.id) ? (
                                                    <CommentAction
                                                        label="Report"
                                                        accessibleLabel={`Report ${display.authorLabel}'s comment`}
                                                        icon={<Flag className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={(event) => {
                                                            reportOpenerRef.current = event.currentTarget;
                                                            setReportTarget(comment);
                                                            setActionError(null);
                                                        }}
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
            ) : null}

            {loading && hasLoaded ? (
                <p className="flex items-center justify-center gap-2 py-3 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading comments…
                </p>
            ) : !loadError && nextOffset !== null && hasLoaded ? (
                <button
                    type="button"
                    onClick={() => void readTopLevel({ kind: 'next-page', offset: nextOffset })}
                    className="ui-focus-ring min-h-11 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-strong)]"
                >
                    Load more comments
                </button>
            ) : null}
        </section>
    );
}

function SignInLink({ href }: { href: string }) {
    return (
        <Link
            href={href}
            className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-3 text-xs font-bold underline underline-offset-2 hover:bg-white/5"
        >
            Sign in
        </Link>
    );
}

function CommentAction({
    label,
    accessibleLabel,
    icon,
    busy,
    onClick,
}: {
    label: string;
    /** Names the comment as well; a screen reader otherwise hears a column of identical buttons. */
    accessibleLabel: string;
    icon?: React.ReactNode;
    busy?: boolean;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={busy}
            aria-label={accessibleLabel}
            className="ui-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-secondary)] disabled:opacity-60"
        >
            {busy
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                : icon}
            {label}
        </button>
    );
}
