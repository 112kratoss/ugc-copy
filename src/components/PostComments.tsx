'use client';

import {
    ChevronDown,
    ChevronUp,
    Flag,
    Heart,
    ListFilter,
    Loader2,
    MessageSquare,
    MoreVertical,
    Pencil,
    Pin,
    PinOff,
    ThumbsDown,
    ThumbsUp,
    Trash2,
    X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import PostCommentAvatar from '@/components/PostCommentAvatar';
import { useAuth } from '@/components/AuthProvider';
import StudioOverflowMenu, { type StudioOverflowMenuItem } from '@/components/StudioOverflowMenu';
import { useConfirmation } from '@/components/useConfirmation';
import {
    POST_COMMENT_MAX_LENGTH,
    POST_COMMENTS_MAX_PAGE_SIZE,
    POST_COMMENTS_PAGE_SIZE,
    adjustReplyCount,
    applyOwnCommentReaction,
    buildCommentThreads,
    buildReplyDraftPrefix,
    buildCommentsQuery,
    canDeleteComment,
    canEditComment,
    canHeartComment,
    canPinComment,
    canRemoveComment,
    canReportComment,
    describeCommentRequestFailure,
    getCommentDisplay,
    isLongComment,
    isPostCreatorComment,
    markCommentRemoved,
    mergeCommentPage,
    nextCommentReaction,
    prependComment,
    withPendingComments,
    type CommentRequestFailure,
    type CommentRequestKind,
    type PostComment,
    type PostCommentReaction,
    type PostCommentSort,
    type PostCommentsPage,
} from '@/lib/post-comments-client';
import { formatCompactCount, formatRelativeTime } from '@/lib/post-feed-presentation';
import { getCurrentInternalPath } from '@/lib/share';

const SORT_OPTIONS: Array<{ value: PostCommentSort; label: string; description: string }> = [
    // Top is the server's order: the most liked first, then the most replied to.
    { value: 'top', label: 'Top', description: 'Most liked first' },
    { value: 'newest', label: 'Newest', description: 'Latest comments first' },
];

/** The composer grows with its draft up to this height, then scrolls. */
const COMPOSER_MAX_HEIGHT_PX = 160;

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
    /**
     * `panel` is the thread as a card of its own beside the post: a header
     * row, the list, and the composer, each padded to the card's edge. Where
     * the page gives the card a height (`.post-comments--panel` in
     * globals.css), the list scrolls inside it and the composer keeps the
     * bottom edge. `flow`, the default, is the thread laid in a column that
     * already has its padding: a feed card, the reel.
     */
    layout?: 'flow' | 'panel';
    /** Draws a close button in the header; the caller hides the thread. */
    onClose?: () => void;
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
    layout = 'flow',
    onClose,
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
    const [composerOpen, setComposerOpen] = useState(false);
    // The handle a reply to a reply opened its draft with. Kept so that a
    // change of target replaces it, and so that it alone is nothing to send.
    const [replyPrefix, setReplyPrefix] = useState('');
    // The comment being reworded in place, and its draft.
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    const [savingEdit, setSavingEdit] = useState(false);
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
    const reportOpenerRef = useRef<HTMLElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // The Reply button a reply was started from: Cancel returns focus to it.
    const replyOpenerRef = useRef<HTMLElement | null>(null);
    // The row menu an edit was opened from: closing the editor returns focus to it.
    const editOpenerRef = useRef<HTMLElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);
    // Comments with a like, a dislike or a heart on its way to the server: a
    // second press waits for the first one's answer.
    const updatingIdsRef = useRef(new Set<string>());
    // Cancel puts focus back on the composer without opening its buttons again.
    const keepComposerFoldedRef = useRef(false);

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
        setReplyPrefix('');
        setComposerOpen(false);
        setReportTarget(null);
        setReportDetails('');
        setReportReason('spam');
        setEditing(null);
        setStatusMessage('');
    }, [postId]);

    useEffect(() => {
        const returnPath = getCurrentInternalPath(`/showcase/${postId}`);
        setLoginHref(`/login?returnUrl=${encodeURIComponent(returnPath)}`);
    }, [postId]);

    useEffect(() => {
        if (reportTarget) {
            // The form opens at the top of the thread; a panel that scrolls
            // inside its card may be anywhere down it.
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
            window.requestAnimationFrame(() => reportReasonRef.current?.focus());
            return;
        }
        // Closing it (Cancel, or a sent report) puts focus back on the menu
        // button its Report came from, so a keyboard or screen-reader user
        // keeps their place.
        const opener = reportOpenerRef.current;
        reportOpenerRef.current = null;
        if (!opener) return;
        window.requestAnimationFrame(() => {
            if (opener.isConnected) opener.focus();
        });
    }, [reportTarget]);

    // The composer is one line until its draft needs more, as the reference
    // thread's is. jsdom lays nothing out and reports no height: left alone.
    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;
        composer.style.height = 'auto';
        if (composer.scrollHeight > 0) {
            // The height is the border box's and scrollHeight leaves the
            // border out: without it the one line overflowed by a pixel and
            // drew a scrollbar wherever scrollbars are always shown.
            const border = composer.offsetHeight - composer.clientHeight;
            composer.style.height = `${Math.min(composer.scrollHeight + border, COMPOSER_MAX_HEIGHT_PX)}px`;
        }
    }, [draft]);

    const startReply = useCallback((comment: PostComment, opener: HTMLElement) => {
        replyOpenerRef.current = opener;
        setReplyTo(comment);
        setComposerOpen(true);
        // A reply to a reply opens by naming who it answers. A draft under way
        // is kept; one that is still only the last target's handle is not, or
        // "Replying to @bob" would sit over a draft that starts "@alice".
        const prefix = buildReplyDraftPrefix(comment);
        setDraft((current) => (current.trim() === '' || current === replyPrefix ? prefix : current));
        setReplyPrefix(prefix);
        window.requestAnimationFrame(() => composerRef.current?.focus());
    }, [replyPrefix]);

    const cancelDraft = useCallback(() => {
        const opener = replyOpenerRef.current;
        replyOpenerRef.current = null;
        setDraft('');
        setReplyTo(null);
        setReplyPrefix('');
        setComposerOpen(false);
        // Cancel is about to leave the page with focus on it. A cancelled
        // reply goes back to the Reply it came from; a cancelled comment stays
        // on the composer, folded to its one line.
        if (opener?.isConnected) {
            opener.focus();
            return;
        }
        keepComposerFoldedRef.current = true;
        composerRef.current?.focus();
        keepComposerFoldedRef.current = false;
    }, []);

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
            setReplyPrefix('');
            replyOpenerRef.current = null;

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

    /** Changes one comment wherever the thread holds it: the lists read and the ones just posted. */
    const mapComment = useCallback((id: string, change: (comment: PostComment) => PostComment) => {
        const inList = (list: PostComment[]) => list.map((item) => (item.id === id ? change(item) : item));
        const inThreads = (threads: Record<string, PostComment[]>) => Object.fromEntries(
            Object.entries(threads).map(([parentId, list]) => [parentId, inList(list)])
        );
        setComments(inList);
        setPendingComments(inList);
        setRepliesByParent(inThreads);
        setPendingRepliesByParent(inThreads);
    }, []);

    /** One change to a comment, answered with the comment as the server now has it. */
    const sendCommentUpdate = useCallback(async (
        commentId: string,
        kind: Extract<CommentRequestKind, 'react' | 'edit' | 'heart' | 'pin'>,
        change: Record<string, unknown>
    ) => {
        const response = await fetch(
            `/api/showcase/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
            { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify(change) }
        );
        // Not JSON from a gateway: see submitComment.
        const data = await response.json().catch(() => ({})) as CommentErrorBody & {
            comment?: PostComment;
            unpinnedCommentId?: string | null;
        };
        if (!response.ok || !data.comment) {
            throw new CommentRequestError(describeCommentRequestFailure(kind, response.status, data));
        }
        return { comment: data.comment, unpinnedCommentId: data.unpinnedCommentId ?? null };
    }, [authHeaders, postId]);

    // A like, a dislike and the creator's heart show at once and are put back
    // if the server refuses. The answer replaces the guess: another reader may
    // have moved the count meanwhile.
    const reactToComment = useCallback(async (comment: PostComment, pressed: PostCommentReaction) => {
        if (updatingIdsRef.current.has(comment.id)) return;
        updatingIdsRef.current.add(comment.id);
        const next = nextCommentReaction(comment.viewerReaction, pressed);
        mapComment(comment.id, (current) => applyOwnCommentReaction(current, next));
        setActionError(null);
        try {
            const { comment: fresh } = await sendCommentUpdate(comment.id, 'react', { reaction: next });
            mapComment(comment.id, () => fresh);
        } catch (reactionError) {
            mapComment(comment.id, (current) => ({
                ...current,
                viewerReaction: comment.viewerReaction,
                likeCount: comment.likeCount,
            }));
            setActionError(toFailure('react', reactionError));
        } finally {
            updatingIdsRef.current.delete(comment.id);
        }
    }, [mapComment, sendCommentUpdate]);

    const heartComment = useCallback(async (comment: PostComment) => {
        if (updatingIdsRef.current.has(comment.id)) return;
        updatingIdsRef.current.add(comment.id);
        const hearted = !comment.hearted;
        mapComment(comment.id, (current) => ({ ...current, hearted }));
        setActionError(null);
        setStatusMessage('');
        try {
            const { comment: fresh } = await sendCommentUpdate(comment.id, 'heart', { hearted });
            mapComment(comment.id, () => fresh);
            setStatusMessage(hearted ? 'Comment hearted.' : 'Heart removed.');
        } catch (heartError) {
            mapComment(comment.id, (current) => ({ ...current, hearted: comment.hearted }));
            setActionError(toFailure('heart', heartError));
        } finally {
            updatingIdsRef.current.delete(comment.id);
        }
    }, [mapComment, sendCommentUpdate]);

    const pinComment = useCallback(async (comment: PostComment) => {
        const pinned = !comment.pinned;
        setBusyCommentId(comment.id);
        setActionError(null);
        setStatusMessage('');
        try {
            const { comment: fresh, unpinnedCommentId } = await sendCommentUpdate(comment.id, 'pin', { pinned });
            mapComment(comment.id, () => fresh);
            if (unpinnedCommentId) {
                mapComment(unpinnedCommentId, (current) => ({ ...current, pinned: false }));
            }
            setStatusMessage(pinned ? 'Comment pinned.' : 'Comment unpinned.');
            // The pinned comment leads the thread and no offset counts it, so
            // a pin moves every later offset: the loaded range is read again,
            // for the same reasons as after a post.
            await readTopLevel({ kind: 'loaded-range', count: commentsRef.current.length });
        } catch (pinError) {
            setActionError(toFailure('pin', pinError));
        } finally {
            setBusyCommentId(null);
        }
    }, [mapComment, readTopLevel, sendCommentUpdate]);

    const closeEditor = useCallback(() => {
        setEditing(null);
        const opener = editOpenerRef.current;
        editOpenerRef.current = null;
        window.requestAnimationFrame(() => {
            if (opener?.isConnected) opener.focus();
        });
    }, []);

    const saveEdit = useCallback(async () => {
        if (!editing || savingEdit) return;
        const body = editing.draft.trim();
        if (!body) return;
        setSavingEdit(true);
        setActionError(null);
        setStatusMessage('');
        try {
            const { comment: fresh } = await sendCommentUpdate(editing.id, 'edit', { body });
            mapComment(editing.id, () => fresh);
            setStatusMessage('Comment edited.');
            closeEditor();
        } catch (editError) {
            setActionError(toFailure('edit', editError));
        } finally {
            setSavingEdit(false);
        }
    }, [closeEditor, editing, mapComment, savingEdit, sendCommentUpdate]);

    useEffect(() => {
        if (!editing) return;
        // Once, when the editor opens: the caret goes after the words to change.
        const editor = editorRef.current;
        if (!editor || document.activeElement === editor) return;
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
    }, [editing]);

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

    const isPanel = layout === 'panel';
    // A reply's opening handle alone is nothing to send.
    const hasSomethingToSend = draft.trim().length > 0
        && (replyPrefix === '' || draft.trim() !== replyPrefix.trim());
    const canSubmit = hasSomethingToSend && !submitting && Boolean(accessToken);
    // The composer's buttons come with the first focus and stay until Cancel,
    // so a draft is never left without its way to send or drop it.
    const composerActive = composerOpen || draft.length > 0 || replyTo !== null;
    const showInitialLoading = loading && !hasLoaded && rows.length === 0;
    const showEmpty = hasLoaded
        && rows.length === 0
        && nextOffset === null
        && !loadError;
    const sortItems: StudioOverflowMenuItem[] = SORT_OPTIONS.map((option) => ({
        key: option.value,
        label: option.label,
        description: option.description,
        checked: sort === option.value,
        onSelect: () => setSort(option.value),
    }));

    // The composer leads a thread laid in a column (a feed card, the reel) and
    // ends a panel, where it is drawn on the bottom edge: its place in the
    // document is its place on the page, so Tab follows what the eye sees.
    const composer = (
        <div className={`post-comments__composer ${isPanel ? 'px-4 py-3' : ''}`}>
            {user ? (
                <div className="flex flex-col gap-2">
                    {replyTo ? (
                        <p className="truncate text-xs text-[var(--ui-text-muted)]">
                            {`Replying to ${getCommentDisplay(replyTo).authorLabel}`}
                        </p>
                    ) : null}
                    <div className="flex items-start gap-3">
                        <PostCommentAvatar
                            avatarUrl={(user.user_metadata?.avatar_url as string | undefined) ?? null}
                            name={(user.user_metadata?.full_name as string | undefined) || user.email || 'You'}
                            size={replyTo ? 24 : 32}
                        />
                        <div className="min-w-0 flex-1">
                            <textarea
                                ref={composerRef}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onFocus={() => {
                                    if (!keepComposerFoldedRef.current) setComposerOpen(true);
                                }}
                                onKeyDown={(event) => {
                                    // Enter is a new line; with Cmd or Ctrl it sends.
                                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                        event.preventDefault();
                                        void submitComment();
                                    }
                                }}
                                maxLength={POST_COMMENT_MAX_LENGTH}
                                rows={1}
                                placeholder={replyTo ? 'Add a reply…' : 'Add a comment…'}
                                aria-label={replyTo ? 'Write a reply' : 'Write a comment'}
                                className="ui-focus-ring block max-h-40 min-h-9 w-full resize-none rounded-lg border-b border-[var(--ui-border-default)] bg-transparent px-1 py-1.5 text-sm leading-6 text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-text-primary)]"
                            />
                            {composerActive ? (
                                <div className="mt-2 flex items-center justify-end gap-2">
                                    {draft.length >= POST_COMMENT_MAX_LENGTH - 200 ? (
                                        <span className="mr-auto text-xs tabular-nums text-[var(--ui-text-faint)]">
                                            {`${draft.length}/${POST_COMMENT_MAX_LENGTH}`}
                                        </span>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={cancelDraft}
                                        aria-label={replyTo ? 'Cancel reply' : 'Cancel comment'}
                                        className="ui-focus-ring min-h-9 rounded-full px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-2)]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void submitComment()}
                                        disabled={!canSubmit}
                                        className="ui-focus-ring inline-flex min-h-9 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
                                    >
                                        {submitting
                                            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                            : null}
                                        {replyTo ? 'Reply' : 'Comment'}
                                    </button>
                                </div>
                            ) : null}
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
        </div>
    );

    return (
        <section
            id={`comments-${postId}`}
            className={`post-comments flex min-w-0 flex-col ${isPanel ? 'post-comments--panel' : 'gap-4'}`}
            aria-label="Comments"
            aria-busy={loading}
        >
            <p className="sr-only" role="status" aria-live="polite">{statusMessage}</p>

            <div className={`post-comments__header flex items-center justify-between gap-3 ${
                isPanel ? 'border-b border-[var(--ui-border-subtle)] py-2 pl-4 pr-2' : ''
            }`}
            >
                <h2 className="flex min-h-9 items-baseline gap-2 text-base font-bold leading-9 text-[var(--ui-text-primary)]">
                    Comments
                    {totalCount > 0 ? (
                        <span className="text-sm font-medium text-[var(--ui-text-muted)]">
                            {formatCompactCount(totalCount)}
                        </span>
                    ) : null}
                </h2>
                <div className="flex items-center gap-1">
                    {/* Sorting nothing is noise: the order appears with the first comment.
                        A menu, not arrow-keyed tabs: in the reel ← and → step through posts. */}
                    {totalCount > 0 ? (
                        <StudioOverflowMenu
                            label="Sort comments"
                            trigger="quiet"
                            triggerIcon={<ListFilter className="h-4 w-4" aria-hidden="true" />}
                            items={sortItems}
                        />
                    ) : null}
                    {onClose ? (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close comments"
                            title="Close comments"
                            className="ui-focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.08] hover:text-zinc-100"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
            </div>

            {isPanel ? null : composer}

            <div
                ref={scrollRef}
                className={`post-comments__scroll flex min-w-0 flex-col gap-4 ${isPanel ? 'px-4 py-3' : ''}`}
            >
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
                                // Under the comment's text, past its avatar.
                                <li key={row.key} className="pl-8">
                                    <div className="flex flex-wrap items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => void toggleReplies(parentId)}
                                            aria-expanded={row.expanded}
                                            aria-label={row.expanded
                                                ? undefined
                                                : `View ${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'}`}
                                            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold text-[var(--ui-primary)] hover:bg-[var(--ui-surface-2)]"
                                        >
                                            {replyPage.loading && !replyPage.hasLoaded
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                : null}
                                            {row.expanded
                                                ? 'Hide replies'
                                                : `${row.replyCount} ${row.replyCount === 1 ? 'reply' : 'replies'}`}
                                            {row.expanded
                                                ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
                                                : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
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
                        const isOwn = canDeleteComment(comment, user?.id);
                        // Everything but Reply sits behind the row's menu, so a
                        // thread reads as comments, not as columns of buttons.
                        const menuItems: StudioOverflowMenuItem[] = [];
                        if (canReportComment(comment, user?.id)) {
                            menuItems.push({
                                key: 'report',
                                label: 'Report',
                                icon: <Flag className="h-4 w-4" aria-hidden="true" />,
                                onSelect: () => {
                                    // The menu has put focus back on its trigger,
                                    // where a closed report form returns it.
                                    reportOpenerRef.current = document.activeElement instanceof HTMLElement
                                        ? document.activeElement
                                        : null;
                                    setReportTarget(comment);
                                    setActionError(null);
                                },
                            });
                        }
                        if (canPinComment(comment, resolvedCreatorId, user?.id)) {
                            menuItems.push({
                                key: 'pin',
                                label: comment.pinned ? 'Unpin' : 'Pin',
                                icon: comment.pinned
                                    ? <PinOff className="h-4 w-4" aria-hidden="true" />
                                    : <Pin className="h-4 w-4" aria-hidden="true" />,
                                onSelect: () => void pinComment(comment),
                            });
                        }
                        if (canEditComment(comment, user?.id)) {
                            menuItems.push({
                                key: 'edit',
                                label: 'Edit',
                                icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
                                onSelect: () => {
                                    // The menu has put focus back on its trigger,
                                    // where a closed editor returns it.
                                    editOpenerRef.current = document.activeElement instanceof HTMLElement
                                        ? document.activeElement
                                        : null;
                                    setEditing({ id: comment.id, draft: comment.body });
                                    setActionError(null);
                                },
                            });
                        }
                        if (isOwn) {
                            menuItems.push({
                                key: 'delete',
                                label: 'Delete',
                                icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                                tone: 'danger',
                                onSelect: () => void removeComment(comment, false),
                            });
                        }
                        if (canRemoveComment(comment, resolvedCreatorId, user?.id)) {
                            menuItems.push({
                                key: 'remove',
                                label: 'Remove',
                                icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                                tone: 'danger',
                                onSelect: () => void removeComment(comment, true),
                            });
                        }

                        return (
                            <li
                                key={row.key}
                                aria-label={isReply ? `Reply from ${display.authorLabel}` : undefined}
                                aria-level={isReply ? 2 : 1}
                                aria-busy={busyCommentId === comment.id}
                                className={`py-2 transition-opacity ${
                                    isReply ? 'ml-4 border-l border-[var(--ui-border-subtle)] pl-5' : ''
                                } ${busyCommentId === comment.id ? 'opacity-60' : ''}`}
                            >
                                {comment.pinned && !display.isDeleted ? (
                                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-[var(--ui-text-muted)]">
                                        <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                                        Pinned by the creator
                                    </p>
                                ) : null}
                                <div className="flex items-start gap-3">
                                    <PostCommentAvatar
                                        avatarUrl={comment.author?.avatarUrl ?? null}
                                        // The initials under a missing picture: the handle's
                                        // "@" gave every such avatar the same one.
                                        name={comment.author?.displayName
                                            || comment.author?.username
                                            || display.authorLabel}
                                        size={isReply ? 24 : 32}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                            {display.authorHref ? (
                                                <Link
                                                    href={display.authorHref}
                                                    prefetch={false}
                                                    className="ui-focus-ring rounded-lg font-bold text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]"
                                                >
                                                    {display.authorLabel}
                                                </Link>
                                            ) : (
                                                <span className="font-bold text-[var(--ui-text-secondary)]">
                                                    {display.authorLabel}
                                                </span>
                                            )}
                                            {isPostCreatorComment(comment, resolvedCreatorId) ? (
                                                <span className="rounded-full bg-[var(--ui-surface-3)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--ui-text-secondary)]">
                                                    Creator
                                                </span>
                                            ) : null}
                                            <span className="text-[var(--ui-text-faint)]">
                                                {formatRelativeTime(comment.createdAt)}
                                                {comment.editedAt && !display.isDeleted ? ' (edited)' : ''}
                                            </span>
                                        </div>
                                        {editing?.id === comment.id ? (
                                            <div className="mt-1">
                                                <textarea
                                                    ref={editorRef}
                                                    value={editing.draft}
                                                    onChange={(event) => setEditing({ id: comment.id, draft: event.target.value })}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Escape') {
                                                            event.preventDefault();
                                                            closeEditor();
                                                        }
                                                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                                            event.preventDefault();
                                                            void saveEdit();
                                                        }
                                                    }}
                                                    maxLength={POST_COMMENT_MAX_LENGTH}
                                                    rows={3}
                                                    aria-label="Edit your comment"
                                                    className="ui-focus-ring block w-full resize-y rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2 text-sm leading-6 text-[var(--ui-text-primary)]"
                                                />
                                                <div className="mt-2 flex items-center justify-end gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={closeEditor}
                                                        aria-label="Cancel edit"
                                                        className="ui-focus-ring min-h-9 rounded-full px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-2)]"
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void saveEdit()}
                                                        disabled={
                                                            savingEdit
                                                            || !editing.draft.trim()
                                                            || editing.draft.trim() === comment.body
                                                        }
                                                        className="ui-focus-ring inline-flex min-h-9 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
                                                    >
                                                        {savingEdit
                                                            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                                            : null}
                                                        Save
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <CommentBody text={display.bodyText} deleted={display.isDeleted} />
                                        )}
                                        {display.isDeleted || editing?.id === comment.id ? null : (
                                            <div className="-ml-2 mt-0.5 flex flex-wrap items-center gap-0.5">
                                                {user ? (
                                                    <>
                                                        <CommentReaction
                                                            kind="like"
                                                            pressed={comment.viewerReaction === 'like'}
                                                            count={comment.likeCount}
                                                            accessibleLabel={`Like ${display.authorLabel}'s comment`}
                                                            onClick={() => void reactToComment(comment, 'like')}
                                                        />
                                                        <CommentReaction
                                                            kind="dislike"
                                                            pressed={comment.viewerReaction === 'dislike'}
                                                            accessibleLabel={`Dislike ${display.authorLabel}'s comment`}
                                                            onClick={() => void reactToComment(comment, 'dislike')}
                                                        />
                                                    </>
                                                ) : (
                                                    // A visitor reads the likes; the press is an account's.
                                                    <Link
                                                        href={loginHref}
                                                        aria-label={`Sign in to like ${display.authorLabel}'s comment`}
                                                        className="ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs font-bold text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                                                    >
                                                        <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                                                        {comment.likeCount > 0 ? formatCompactCount(comment.likeCount) : null}
                                                    </Link>
                                                )}
                                                {canHeartComment(comment, resolvedCreatorId, user?.id) ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => void heartComment(comment)}
                                                        aria-pressed={comment.hearted}
                                                        aria-label={`Heart ${display.authorLabel}'s comment`}
                                                        title={comment.hearted ? 'Remove your heart' : 'Heart this comment'}
                                                        className={`ui-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[var(--ui-surface-2)] ${
                                                            comment.hearted
                                                                ? 'text-[var(--ui-primary)]'
                                                                : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
                                                        }`}
                                                    >
                                                        <Heart
                                                            className={`h-4 w-4 ${comment.hearted ? 'fill-current' : ''}`}
                                                            aria-hidden="true"
                                                        />
                                                    </button>
                                                ) : comment.hearted ? (
                                                    <span
                                                        title="Loved by the creator"
                                                        className="inline-flex h-9 items-center gap-1 px-2 text-[var(--ui-primary)]"
                                                    >
                                                        <Heart className="h-4 w-4 fill-current" aria-hidden="true" />
                                                        <span className="sr-only">Loved by the creator</span>
                                                    </span>
                                                ) : null}
                                                {user ? (
                                                    <CommentAction
                                                        label="Reply"
                                                        accessibleLabel={`Reply to ${display.authorLabel}`}
                                                        onClick={(event) => startReply(comment, event.currentTarget)}
                                                    />
                                                ) : null}
                                            </div>
                                        )}
                                    </div>
                                    {display.isDeleted || menuItems.length === 0 ? null : (
                                        <StudioOverflowMenu
                                            label={isOwn
                                                ? 'More actions for your comment'
                                                : `More actions for ${display.authorLabel}'s comment`}
                                            trigger="quiet"
                                            triggerIcon={<MoreVertical className="h-4 w-4" aria-hidden="true" />}
                                            disabled={busyCommentId === comment.id}
                                            items={menuItems}
                                        />
                                    )}
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
            </div>

            {isPanel ? composer : null}
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

/**
 * A comment's text. A long one opens folded to four lines behind "Read more",
 * so one essay cannot push the rest of the thread out of a short panel.
 */
function CommentBody({ text, deleted }: { text: string; deleted: boolean }) {
    const long = !deleted && isLongComment(text);
    const [unfolded, setUnfolded] = useState(false);
    // The text decides which comments may fold; the page decides which do. A
    // paragraph of 400 characters is four lines in a narrow panel and three in
    // a wide column, where "Read more" would toggle nothing. jsdom lays nothing
    // out and reports no height: the fold stays, as the text alone decided.
    const [fits, setFits] = useState(false);
    const bodyRef = useRef<HTMLParagraphElement | null>(null);
    useLayoutEffect(() => {
        const body = bodyRef.current;
        if (!long || unfolded || !body || body.clientHeight === 0) return;
        setFits(body.scrollHeight <= body.clientHeight + 1);
    }, [long, text, unfolded]);
    const foldable = long && !fits;

    return (
        <>
            <p
                ref={bodyRef}
                className={`whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere] ${
                deleted
                    ? 'italic text-[var(--ui-text-faint)]'
                    : 'text-[var(--ui-text-primary)]'
            } ${long && !unfolded ? 'line-clamp-4' : ''}`}
            >
                {text}
            </p>
            {foldable ? (
                <button
                    type="button"
                    onClick={() => setUnfolded((current) => !current)}
                    aria-expanded={unfolded}
                    className="ui-focus-ring -ml-2 min-h-9 rounded-full px-2 text-xs font-bold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
                >
                    {unfolded ? 'Show less' : 'Read more'}
                </button>
            ) : null}
        </>
    );
}

/** A like or a dislike: a toggle that shows the likes, and never how many disliked. */
function CommentReaction({
    kind,
    pressed,
    count = 0,
    accessibleLabel,
    onClick,
}: {
    kind: PostCommentReaction;
    pressed: boolean;
    count?: number;
    /** Names the comment as well; a screen reader otherwise hears a column of identical buttons. */
    accessibleLabel: string;
    onClick: () => void;
}) {
    const Icon = kind === 'like' ? ThumbsUp : ThumbsDown;
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={pressed}
            aria-label={accessibleLabel}
            className={`ui-focus-ring inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-bold tabular-nums transition hover:bg-[var(--ui-surface-2)] ${
                pressed
                    ? 'text-[var(--ui-text-primary)]'
                    : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
            }`}
        >
            <Icon className={`h-4 w-4 ${pressed ? 'fill-current' : ''}`} aria-hidden="true" />
            {count > 0 ? formatCompactCount(count) : null}
        </button>
    );
}

function CommentAction({
    label,
    accessibleLabel,
    onClick,
}: {
    label: string;
    /** Names the comment as well; a screen reader otherwise hears a column of identical buttons. */
    accessibleLabel: string;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={accessibleLabel}
            className="ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
        >
            {label}
        </button>
    );
}
