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
    mergeCommentPage,
    prependComment,
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

interface ReplyPageState {
    hasLoaded: boolean;
    loading: boolean;
    nextOffset: number | null;
    error: string | null;
}

interface PostCommentsProps {
    postId: string;
    postCreatorId: string | null;
    commentCount: number;
    onCommentCountChange?: (commentCount: number) => void;
    /** Loads the first page immediately instead of waiting for a "load" tap. */
    autoLoad?: boolean;
}

function emptyReplyPageState(): ReplyPageState {
    return {
        hasLoaded: false,
        loading: false,
        nextOffset: 0,
        error: null,
    };
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
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
    const [replyPages, setReplyPages] = useState<Record<string, ReplyPageState>>({});
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [nextOffset, setNextOffset] = useState<number | null>(0);
    const [resolvedCreatorId, setResolvedCreatorId] = useState(postCreatorId);
    const [totalCount, setTotalCount] = useState(commentCount);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loading, setLoading] = useState(autoLoad);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
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
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const reportReasonRef = useRef<HTMLSelectElement | null>(null);

    const authHeaders = useCallback((json = false) => {
        const headers: Record<string, string> = {};
        if (json) headers['Content-Type'] = 'application/json';
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        return headers;
    }, [accessToken]);

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

    const loadPage = useCallback(async (
        offset: number,
        replace: boolean
    ): Promise<PostCommentsPage | null> => {
        const requestId = ++topLevelRequestIdRef.current;
        topLevelAbortRef.current?.abort();
        const controller = new AbortController();
        topLevelAbortRef.current = controller;

        setLoading(true);
        setLoadError(null);

        try {
            const query = buildCommentsQuery({ offset, sort });
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments?${query}`,
                {
                    headers: authHeaders(),
                    signal: controller.signal,
                }
            );
            if (!response.ok) throw new Error('Could not load comments');

            const page = await response.json() as PostCommentsPage;
            if (requestId !== topLevelRequestIdRef.current) return null;

            setComments((current) => mergeCommentPage(current, page.comments, replace));
            setNextOffset(page.pageInfo.hasMore ? page.pageInfo.nextOffset : null);
            setResolvedCreatorId(page.postCreatorId ?? postCreatorId);
            setHasLoaded(true);
            publishCount(page.commentCount);
            return page;
        } catch (error) {
            if (isAbortError(error) || requestId !== topLevelRequestIdRef.current) {
                return null;
            }
            setHasLoaded(true);
            setLoadError('We could not load this conversation.');
            return null;
        } finally {
            if (requestId === topLevelRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, [authHeaders, postCreatorId, postId, publishCount, sort]);

    const loadReplies = useCallback(async (
        parentId: string,
        offset: number,
        replace: boolean
    ): Promise<PostCommentsPage | null> => {
        const requestId = (replyRequestIdsRef.current[parentId] ?? 0) + 1;
        replyRequestIdsRef.current[parentId] = requestId;
        setReplyPages((current) => ({
            ...current,
            [parentId]: {
                ...(current[parentId] ?? emptyReplyPageState()),
                loading: true,
                error: null,
            },
        }));

        try {
            const query = buildCommentsQuery({ parentId, offset });
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments?${query}`,
                { headers: authHeaders() }
            );
            if (!response.ok) throw new Error('Could not load replies');

            const page = await response.json() as PostCommentsPage;
            if (replyRequestIdsRef.current[parentId] !== requestId) return null;

            setRepliesByParent((current) => ({
                ...current,
                [parentId]: mergeCommentPage(current[parentId] ?? [], page.comments, replace),
            }));
            setReplyPages((current) => ({
                ...current,
                [parentId]: {
                    hasLoaded: true,
                    loading: false,
                    nextOffset: page.pageInfo.hasMore ? page.pageInfo.nextOffset : null,
                    error: null,
                },
            }));
            return page;
        } catch {
            if (replyRequestIdsRef.current[parentId] !== requestId) return null;
            setReplyPages((current) => ({
                ...current,
                [parentId]: {
                    ...(current[parentId] ?? emptyReplyPageState()),
                    loading: false,
                    error: 'Could not load replies.',
                },
            }));
            return null;
        }
    }, [authHeaders, postId]);

    // Sort changes and authentication changes both require a clean, viewer-safe
    // first page. Aborting the previous request prevents an older sort from
    // overwriting the current selection.
    useEffect(() => {
        const replyRequestIds = replyRequestIdsRef.current;
        setComments([]);
        setRepliesByParent({});
        setReplyPages({});
        setExpandedIds(new Set());
        setNextOffset(0);
        setResolvedCreatorId(postCreatorId);
        setHasLoaded(false);
        setLoadError(null);
        setActionError(null);
        setLoading(autoLoad);

        if (autoLoad) {
            void loadPage(0, true);
        }

        return () => {
            topLevelRequestIdRef.current += 1;
            topLevelAbortRef.current?.abort();
            topLevelAbortRef.current = null;
            for (const parentId of Object.keys(replyRequestIds)) {
                replyRequestIds[parentId] += 1;
            }
        };
    }, [accessToken, autoLoad, loadPage, postCreatorId, postId]);

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
        if (!reportTarget) return;
        window.requestAnimationFrame(() => reportReasonRef.current?.focus());
    }, [reportTarget]);

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
            await loadReplies(parentId, 0, true);
        }
    }, [expandedIds, loadReplies, replyPages]);

    const submitComment = useCallback(async () => {
        const body = draft.trim();
        if (!body || submitting || !accessToken) return;

        setSubmitting(true);
        setActionError(null);
        setStatusMessage('');
        // Be defensive if a stale client ever supplies a reply as the target:
        // the product supports one reply level, so normalize to the root.
        const parentId = replyTo?.parentId ?? replyTo?.id ?? null;

        try {
            const response = await fetch(`/api/showcase/posts/${encodeURIComponent(postId)}/comments`, {
                method: 'POST',
                headers: authHeaders(true),
                body: JSON.stringify({ body, parentId }),
            });
            const data = await response.json() as {
                comment?: PostComment;
                commentCount?: number;
                error?: string;
            };
            if (!response.ok || !data.comment) {
                throw new Error(data.error || 'Could not post comment');
            }

            setDraft('');
            setReplyTo(null);

            if (parentId) {
                setComments((current) => adjustReplyCount(current, parentId, 1));
                setExpandedIds((current) => new Set(current).add(parentId));

                if (replyPages[parentId]?.hasLoaded) {
                    setRepliesByParent((current) => ({
                        ...current,
                        [parentId]: mergeCommentPage(
                            current[parentId] ?? [],
                            [data.comment as PostComment]
                        ),
                    }));
                }
            } else {
                setComments((current) => prependComment(current, data.comment as PostComment));
            }

            publishCount(data.commentCount ?? totalCount + 1);
            setStatusMessage(parentId ? 'Reply posted.' : 'Comment posted.');
            composerRef.current?.focus();

            // Mutations can change top ranking and every following offset. A
            // server refresh keeps page boundaries authoritative and prevents a
            // later "Load more" from skipping or duplicating comments.
            const refreshes: Array<Promise<PostCommentsPage | null>> = [loadPage(0, true)];
            if (parentId) {
                refreshes.push(loadReplies(parentId, 0, true));
            }
            await Promise.all(refreshes);
        } catch (submitError) {
            setActionError(
                submitError instanceof Error ? submitError.message : 'Could not post comment.'
            );
        } finally {
            setSubmitting(false);
        }
    }, [
        accessToken,
        authHeaders,
        draft,
        loadPage,
        loadReplies,
        postId,
        publishCount,
        replyPages,
        replyTo,
        submitting,
        totalCount,
    ]);

    const removeComment = useCallback(async (comment: PostComment, asOwner: boolean) => {
        const confirmed = window.confirm(asOwner
            ? 'Remove this comment? It will be hidden from everyone viewing your post.'
            : 'Delete your comment? It will be replaced with “[deleted]”. Replies to it stay visible.');
        if (!confirmed) return;

        setBusyCommentId(comment.id);
        setActionError(null);
        setStatusMessage('');
        try {
            const response = await fetch(
                `/api/showcase/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(comment.id)}`,
                { method: 'DELETE', headers: authHeaders() }
            );
            const data = await response.json() as {
                status?: PostComment['status'];
                commentCount?: number;
                error?: string;
            };
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
                setComments((current) => markCommentRemoved(
                    current,
                    comment.id,
                    data.status as PostComment['status']
                ));
            }

            publishCount(data.commentCount ?? Math.max(0, totalCount - 1));
            setStatusMessage(asOwner ? 'Comment removed.' : 'Comment deleted.');

            const refreshes: Array<Promise<PostCommentsPage | null>> = [loadPage(0, true)];
            if (comment.parentId) {
                refreshes.push(loadReplies(comment.parentId, 0, true));
            }
            await Promise.all(refreshes);
        } catch (removeError) {
            setActionError(
                removeError instanceof Error ? removeError.message : 'Could not remove comment.'
            );
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders, loadPage, loadReplies, postId, publishCount, totalCount]);

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
            const data = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(data?.error || 'Could not report comment');

            setReportTarget(null);
            setReportDetails('');
            setReportReason('spam');
            setStatusMessage('Report submitted for review.');
        } catch (reportError) {
            setActionError(
                reportError instanceof Error ? reportError.message : 'Could not report that comment.'
            );
        } finally {
            setBusyCommentId(null);
        }
    }, [authHeaders, busyCommentId, reportDetails, reportReason, reportTarget]);

    const rows = useMemo(
        () => buildCommentThreads({ topLevel: comments, repliesByParent, expandedIds }),
        [comments, expandedIds, repliesByParent]
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
                    <span>{actionError}</span>
                    <button
                        type="button"
                        onClick={() => setActionError(null)}
                        className="ui-focus-ring min-h-11 rounded-full px-3 text-xs font-bold hover:bg-white/5"
                    >
                        Dismiss
                    </button>
                </div>
            ) : null}

            {loadError ? (
                <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]"
                >
                    <span>{loadError}</span>
                    <button
                        type="button"
                        onClick={() => void loadPage(0, true)}
                        className="ui-focus-ring min-h-11 rounded-full border border-current px-4 text-xs font-bold"
                    >
                        Retry
                    </button>
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
                                                onClick={() => void loadReplies(
                                                    parentId,
                                                    replyPage.nextOffset as number,
                                                    false
                                                )}
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
                                            <span>{replyPage.error}</span>
                                            <button
                                                type="button"
                                                onClick={() => void loadReplies(parentId, 0, true)}
                                                className="ui-focus-ring min-h-11 rounded-full px-3 font-bold hover:bg-[var(--ui-surface-2)]"
                                            >
                                                Retry replies
                                            </button>
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
                                                        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, false)}
                                                    />
                                                ) : null}
                                                {canRemoveComment(comment, resolvedCreatorId, user?.id) ? (
                                                    <CommentAction
                                                        label="Remove"
                                                        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => void removeComment(comment, true)}
                                                    />
                                                ) : null}
                                                {canReportComment(comment, user?.id) ? (
                                                    <CommentAction
                                                        label="Report"
                                                        icon={<Flag className="h-3.5 w-3.5" aria-hidden="true" />}
                                                        busy={busyCommentId === comment.id}
                                                        onClick={() => {
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

            {!autoLoad && !hasLoaded ? (
                <button
                    type="button"
                    onClick={() => void loadPage(0, true)}
                    className="ui-focus-ring min-h-11 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)]"
                >
                    Load comments
                </button>
            ) : null}

            {loading && hasLoaded ? (
                <p className="flex items-center justify-center gap-2 py-3 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading comments…
                </p>
            ) : !loadError && nextOffset !== null && hasLoaded ? (
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
            className="ui-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-secondary)] disabled:opacity-60"
        >
            {busy
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                : icon}
            {label}
        </button>
    );
}
