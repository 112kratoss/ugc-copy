import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Check, Heart, MoreHorizontal, Pin, SendHorizontal, ThumbsDown, ThumbsUp } from 'lucide-react-native';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, FlatList, type LayoutChangeEvent, Platform, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NativeMenu } from '@/components/native-menu';
import { CommentListSkeleton } from '@/components/skeleton';
import { CreatorAvatar, PrimaryButton, SegmentedControl, StatusBlock } from '@/components/ui';
import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import {
  ALL_POST_COMMENT_QUERY_KEYS,
  DEFAULT_POST_COMMENT_SORT,
  POST_COMMENTS_PAGE_SIZE,
  POST_COMMENT_MAX_LENGTH,
  POST_COMMENT_SORTS,
  HEARTED_COMMENT_LABEL,
  PINNED_COMMENT_LABEL,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  applyCommentCountToSourceData,
  appendReplyToPages,
  applyOwnCommentReaction,
  buildReplyDraftPrefix,
  canBlockCommentAuthor,
  canDeleteComment,
  canEditComment,
  canHeartComment,
  canPinComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  createPostCommentsThreadQueryKey,
  getCommentAuthReturnTo,
  draftForReplyTarget,
  getCommentDisplay,
  getCommentLikeCountLabel,
  getCommentPostErrorCopy,
  getCommentUpdateErrorCopy,
  getCommentsLoadErrorCopy,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  getRemoveCommentConfirmation,
  getRepliesToggleLabel,
  hasCommentToSend,
  hasUnsavedCommentEdit,
  incrementParentReplyCountInPages,
  incrementReplyCountInList,
  isLongComment,
  isPostCreatorComment,
  keepFirstCommentPage,
  leadCommentPagesWith,
  mapCommentInList,
  mapCommentInPages,
  markCommentRemovedInList,
  markCommentRemovedInPages,
  mergeRepliesWithPending,
  mergeTopLevelWithPending,
  nextCommentReaction,
  prependCommentToPages,
  suspendCommentPagination,
  type CommentUpdateKind,
  type PostCommentSort,
} from '@/lib/comments-view-model';
import { buildCommentMenu } from '@/lib/comment-menu';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { useReducedMotion } from '@/lib/motion';
import { actionSheetFromMenu, hasNativeMenuItems, type NativeMenuModel } from '@/lib/native-menu';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { resolvedBottomInset } from '@/lib/safe-area';
import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { Overlay } from '@/components/overlay-host';
import { SheetGrabber, useSheetDismissDrag } from '@/components/sheet-chrome';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { verticalHitSlop } from '@/lib/hit-target';
import { takeOffHomeShelf } from '@/lib/home-shelf-cache';
import { useMenuHandoff } from '@/lib/menu-handoff';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { CommentReportReason } from '@/lib/api-client';
import type {
  OwnerPostsResponse,
  PostComment,
  PostCommentReaction,
  PostCommentsResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';

// The web thread's labels (src/components/PostComments.tsx), so a report reads
// the same whichever client filed it.
const REPORT_REASONS: Array<{ label: string; value: CommentReportReason }> = [
  { label: 'Spam', value: 'spam' },
  { label: 'Harassment', value: 'harassment' },
  { label: 'Unsafe content', value: 'unsafe_content' },
  { label: 'Other', value: 'other' },
];

type CommentActionHandler = (comment: PostComment) => void;
type HeldComposer = { draft: string; replyTo: PostComment | null; replyPrefix: string };
type CommentReactionHandler = (comment: PostComment, reaction: PostCommentReaction) => void;
/** What a row needs to draw a comment's likes, heart and marks, and to act on them. */
type CommentRowActions = {
  postCreatorId: string | null;
  viewerUserId: string | null;
  onReact: CommentReactionHandler;
  onHeart: CommentActionHandler;
  onReply: CommentActionHandler;
};
type CommentMenuBuilder = (comment: PostComment) => NativeMenuModel;
type AuthorOpenHandler = (username: string) => void;

export type PostCommentsHandle = {
  focusComposer: () => void;
  scrollToComments: (options?: { focus?: boolean }) => void;
};

type PostCommentsProps = {
  postId: string;
  postCreatorId: string | null;
  postTitle?: string | null;
  commentCount: number;
  visible?: boolean;
  enabled?: boolean;
  presentation: 'sheet' | 'inline';
  contentHeader?: React.ReactNode;
  onClose?: () => void;
  onCommentCountChange?: (commentCount: number) => void;
  authReturnTo?: string;
  initialReplyToId?: string | null;
  unavailableMessage?: string | null;
  /**
   * The feed delivery the thread was opened from (a ranked Home card, the reel
   * it opened), sent with each new comment so the server can credit it to that
   * delivery. Absent anywhere the post was not reached through a ranked feed.
   */
  deliveryId?: string | null;
};

export const PostComments = forwardRef<PostCommentsHandle, PostCommentsProps>(function PostComments({
  postId,
  postCreatorId,
  postTitle,
  commentCount,
  visible = true,
  enabled = true,
  presentation,
  contentHeader,
  onClose = () => undefined,
  onCommentCountChange,
  authReturnTo,
  initialReplyToId,
  unavailableMessage,
  deliveryId,
}, ref) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const { api, user } = useAuth();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);

  // The order the reader picked, kept with the post it was picked on: every
  // thread opens on Top, as the web's does, and a sheet that moves on to
  // another post never asks for the new post's thread in the old order first.
  const [sortChoice, setSortChoice] = useState<{ postId: string; sort: PostCommentSort } | null>(null);
  const sort = sortChoice?.postId === postId ? sortChoice.sort : DEFAULT_POST_COMMENT_SORT;
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  // The handle a reply to a reply opened its draft with: a change of target
  // replaces it, and it alone is nothing to send.
  const [replyPrefix, setReplyPrefix] = useState('');
  // The viewer's own comment being reworded: the composer holds its words.
  const [editing, setEditing] = useState<PostComment | null>(null);
  // What the composer held when an edit took it over (an unsent comment or
  // reply, and who it answered): put back when the edit is saved or cancelled.
  const [heldComposer, setHeldComposer] = useState<HeldComposer | null>(null);
  // The field's words for the handlers that must not change with every key
  // pressed (each row holds them): read in a press, never while drawing.
  const draftRef = useRef('');
  // Comments with a heart on its way to the server: a second press on the
  // heart waits for the first one's answer.
  const updatingIdsRef = useRef(new Set<string>());
  // Comments with a like or a dislike on its way, and the reaction pressed
  // meanwhile, which is sent when that answer lands (reactToComment).
  const reactingIdsRef = useRef(new Set<string>());
  const queuedReactionsRef = useRef(new Map<string, PostCommentReaction | null>());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [pendingRepliesByParent, setPendingRepliesByParent] = useState<Record<string, PostComment[]>>({});
  // The viewer's own top-level comments from this thread, pinned above the
  // server's pages (`mergeTopLevelWithPending`).
  const [pendingTopLevel, setPendingTopLevel] = useState<PostComment[]>([]);
  const [reporting, setReporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Decoupled from query fetch state: on iOS a programmatic `refreshing` drags
  // the list down and can strand it there, so only a refresh the user asked
  // for may engage the control (see the note in app/(tabs)/showcase.tsx).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const restoredReplyIdRef = useRef<string | null>(null);
  const commentsListRef = useRef<FlatList<PostComment>>(null);
  const composerRef = useRef<TextInput>(null);
  const commentsOffsetRef = useRef(0);

  // An author's profile or sign-in, opened from the sheet, is pushed at the tap
  // and the sheet stays until that screen has been built under it, then leaves
  // over it (`lib/menu-handoff.ts`). Closed first, it left a render before the
  // screen was built, since expo-router builds a pushed screen a render later:
  // the post showed bare in between, and on Home, which unmounts the sheet as
  // it closes, at once. Inline, on the post page, nothing covers the page.
  const handoff = useMenuHandoff<string>({ visible: presentation === 'sheet' && visible, onClose });
  const shown = visible && !handoff.leaving;

  // A visible Modal used to consume the back key before any listener ran. The
  // sheet is an ordinary view now, so it has to claim the key itself — gated on
  // being open so the screen underneath keeps it the rest of the time.
  useHardwareBack(shown && presentation === 'sheet', onClose);

  // The Modal this replaced animated itself with `animationType="slide"`. An
  // overlay is an ordinary view, so the sheet owns that motion now — including
  // staying mounted through its exit, which a bare `visible` unmount would cut
  // off mid-flight.
  const { height: windowHeight } = useWindowDimensions();
  const [presented, setPresented] = useState(shown);
  const slide = useRef(new Animated.Value(shown ? 1 : 0)).current;

  useEffect(() => {
    if (shown) setPresented(true);
  }, [shown]);

  useEffect(() => {
    if (!presented || presentation !== 'sheet') return;

    if (reducedMotion) {
      slide.setValue(shown ? 1 : 0);
      if (!shown) setPresented(false);
      return;
    }

    const animation = Animated.timing(slide, {
      toValue: shown ? 1 : 0,
      duration: shown ? 280 : 200,
      // Decelerate in, accelerate out: the sheet arrives settling and leaves
      // like it was let go.
      easing: shown ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !shown) setPresented(false);
    });

    return () => animation.stop();
  }, [presentation, presented, reducedMotion, shown, slide]);

  // The drag rides on top of the slide translation, which is why this one folds
  // the offset into its own transform instead of appending a second one.
  const sheetDrag = useSheetDismissDrag({ onDismiss: onClose, visible: shown });
  // The slide's and the scrim's nodes are built once per opening, not on every
  // render. The sheet re-renders on every keystroke in its composer, and
  // mid-slide: its owner's close lands a render after its exit over an
  // author's profile has begun, and nodes built anew there are connected to
  // the views again under the running slide (the side menu stopped for 72 ms
  // that way, components/home-side-menu.tsx). The compiler skips this
  // component, so the memos are written out.
  //
  // The scrim thins as the sheet is pulled away, on top of its own entrance.
  const backdropOpacity = useMemo(() => (
    sheetDrag.backdropOpacity && typeof Animated.multiply === 'function'
      ? Animated.multiply(slide, sheetDrag.backdropOpacity)
      : slide
  ), [sheetDrag.backdropOpacity, slide]);
  const sheetTranslateY = useMemo(() => {
    const entry = slide.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] });
    return sheetDrag.translateY ? Animated.add(entry, sheetDrag.translateY) : entry;
  }, [sheetDrag.translateY, slide, windowHeight]);


  const commentsQueryKey = createPostCommentsQueryKey(postId, sort, user?.id);

  const commentsQuery = useInfiniteQuery({
    queryKey: commentsQueryKey,
    enabled: visible && enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listPostComments(
      postId,
      getCommentsPageParams({ offset: pageParam as number, sort, limit: POST_COMMENTS_PAGE_SIZE })
    ),
    getNextPageParam: getNextCommentsPageOffset,
  });

  const topLevel = useMemo(
    () => mergeTopLevelWithPending(commentsQuery.data?.pages, pendingTopLevel),
    [commentsQuery.data?.pages, pendingTopLevel]
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setDraft('');
    setReplyTo(null);
    setReplyPrefix('');
    setEditing(null);
    setHeldComposer(null);
    setExpandedIds(new Set());
    setPendingRepliesByParent({});
    setPendingTopLevel([]);
    setReporting(false);
    restoredReplyIdRef.current = null;
  }, [postId]);

  useEffect(() => {
    if (
      !visible
      || !enabled
      || !initialReplyToId
      || restoredReplyIdRef.current === initialReplyToId
    ) {
      return;
    }
    const comment = topLevel.find((item) => item.id === initialReplyToId && !item.parentId);
    if (!comment) {
      if (commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) {
        void commentsQuery.fetchNextPage();
      }
      return;
    }
    restoredReplyIdRef.current = initialReplyToId;
    setReplyTo(comment);
  }, [
    commentsQuery.fetchNextPage,
    commentsQuery.hasNextPage,
    commentsQuery.isFetchingNextPage,
    initialReplyToId,
    topLevel,
    visible,
    enabled,
  ]);

  const serverCommentCount = commentsQuery.data?.pages?.[0]?.commentCount ?? commentCount;
  const resolvedPostCreatorId = commentsQuery.data?.pages?.[0]?.postCreatorId ?? postCreatorId;
  const commentsUnavailable = commentsQuery.isError && !commentsQuery.data?.pages?.length;
  const loadError = commentsUnavailable ? getCommentsLoadErrorCopy(commentsQuery.error) : null;
  // Closed is an answer, not a failure: no retry, and no composer inviting a comment.
  const commentsClosed = loadError ? !loadError.canRetry : false;

  const publishCommentCount = useCallback((nextCount: number) => {
    const result = { postId, commentCount: nextCount };

    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: ['showcase-feed'] },
      (current) => applyCommentCountToInfiniteFeed(current, result)
    );
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: ['profile-saved-media'] },
      (current) => applyCommentCountToInfiniteFeed(current, result)
    );
    queryClient.setQueriesData<ShowcasePostResponse>(
      { queryKey: ['showcase-post', postId] },
      (current) => applyCommentCountToPostResponse(current, result)
    );
    queryClient.setQueriesData<ImmersiveSourceData>(
      { queryKey: ['immersive-preview-source'] },
      (current) => applyCommentCountToSourceData(current, result)
    );
    queryClient.setQueriesData<InfiniteData<OwnerPostsResponse>>(
      { queryKey: ['profile-owner-posts'] },
      (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          posts: page.posts.map((post) => (
            post.id === postId ? { ...post, commentCount: result.commentCount } : post
          )),
        })),
      } : current
    );
    queryClient.setQueriesData<{ success: boolean; post: OwnerPostsResponse['posts'][number] }>(
      { queryKey: ['owner-text-post', postId] },
      (current) => current ? {
        ...current,
        post: { ...current.post, commentCount: result.commentCount },
      } : current
    );
    onCommentCountChange?.(nextCount);
  }, [onCommentCountChange, postId, queryClient]);

  const openSignIn = useCallback((replyComment?: PostComment | null) => {
    const rootReplyId = replyComment
      ? replyComment.parentId ?? replyComment.id
      : null;
    const signIn = () => router.push({
      pathname: '/auth',
      params: {
        returnTo: getCommentAuthReturnTo(authReturnTo, postId, rootReplyId),
      },
    } as never);
    if (presentation === 'sheet') {
      handoff.handOff('/auth', signIn);
      return;
    }
    onClose();
    signIn();
  }, [authReturnTo, handoff.handOff, onClose, postId, presentation]);

  const requireSignIn = useCallback((replyComment?: PostComment | null) => {
    if (user) return true;
    openSignIn(replyComment);
    return false;
  }, [openSignIn, user]);

  const openAuthorProfile = useCallback((username: string) => {
    const href = `/creators/${encodeURIComponent(username)}`;
    // Left open, the sheet would still cover the post when the reader comes
    // back from the profile, so it closes, as it does for sign-in: once the
    // profile has been built under it.
    if (presentation === 'sheet') {
      handoff.handOff(href, () => router.push(href as never));
      return;
    }
    router.push(href as never);
  }, [handoff.handOff, presentation]);

  const toggleReplies = useCallback((parentId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);

  // A write lands in the order on screen, which refetches straight after it.
  // The other order's pages were read before the write, so they are marked
  // stale here and read again when the reader switches to them; until then
  // they would show the old count and keep a removed comment.
  const markThreadStale = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: createPostCommentsThreadQueryKey(postId),
      refetchType: 'none',
    });
  }, [postId, queryClient]);

  // The control reports only a real change, and ticks it itself (`SegmentedControl`).
  const selectSort = useCallback((next: PostCommentSort) => {
    setSortChoice({ postId, sort: next });
    // In the sheet the control sits above the list, which may be scrolled
    // far down the old order; the new one is read from its start. On the
    // post page the control is in the list's own header, already in view.
    if (presentation === 'sheet') {
      commentsListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [postId, presentation]);

  /** Changes one comment wherever the thread holds it: the cached pages and the ones just posted. */
  const patchComment = useCallback((target: PostComment, change: (comment: PostComment) => PostComment) => {
    queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
      commentsQueryKey,
      (current) => mapCommentInPages(current, target.id, change)
    );
    setPendingTopLevel((current) => mapCommentInList(current, target.id, change));
    if (target.parentId) {
      const parentId = target.parentId;
      queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
        createPostCommentRepliesQueryKey(postId, parentId, user?.id),
        (current) => mapCommentInPages(current, target.id, change)
      );
      setPendingRepliesByParent((current) => (current[parentId]
        ? { ...current, [parentId]: mapCommentInList(current[parentId], target.id, change) }
        : current));
    }
  }, [commentsQueryKey, postId, queryClient, user?.id]);

  const reportUpdateFailure = useCallback((error: unknown, kind: CommentUpdateKind) => {
    haptic.error();
    const copy = getCommentUpdateErrorCopy(error, kind);
    if (copy.signIn) {
      void showConfirmDialog({ title: copy.title, message: copy.message, confirmLabel: 'Sign in' })
        .then((confirmed) => {
          if (confirmed) openSignIn();
        });
      return;
    }
    showMessageDialog({ title: copy.title, message: copy.message });
  }, [openSignIn]);

  // A like, a dislike and the creator's heart show at once and are put back if
  // the server refuses. The answer replaces the guess: another reader may have
  // moved the count meanwhile.
  const reactToComment = useCallback((comment: PostComment, pressed: PostCommentReaction) => {
    if (!requireSignIn()) return;
    const next = nextCommentReaction(comment.viewerReaction, pressed);
    haptic.select();
    patchComment(comment, (current) => applyOwnCommentReaction(current, next));
    // A press while the last one is still on its way (a like corrected to a
    // dislike on a slow connection) is not dropped: it shows at once and is
    // sent when that answer lands. The latest press is the one kept.
    if (reactingIdsRef.current.has(comment.id)) {
      queuedReactionsRef.current.set(comment.id, next);
      return;
    }
    reactingIdsRef.current.add(comment.id);
    // What the server last confirmed: where a refusal puts the comment back.
    let settled = { viewerReaction: comment.viewerReaction ?? null, likeCount: comment.likeCount ?? 0 };
    const send = (wanted: PostCommentReaction | null): Promise<void> => (
      api.updatePostComment(postId, comment.id, { reaction: wanted }).then((response) => {
        const fresh = response.comment;
        settled = { viewerReaction: fresh.viewerReaction ?? null, likeCount: fresh.likeCount ?? 0 };
        const queued = queuedReactionsRef.current;
        if (!queued.has(comment.id) || queued.get(comment.id) === settled.viewerReaction) {
          queued.delete(comment.id);
          patchComment(comment, () => fresh);
          markThreadStale();
          return undefined;
        }
        const following = queued.get(comment.id) ?? null;
        queued.delete(comment.id);
        patchComment(comment, () => applyOwnCommentReaction(fresh, following));
        return send(following);
      })
    );
    send(next)
      .catch((error: unknown) => {
        queuedReactionsRef.current.delete(comment.id);
        const confirmed = settled;
        patchComment(comment, (current) => ({ ...current, ...confirmed }));
        reportUpdateFailure(error, 'react');
      })
      .finally(() => {
        reactingIdsRef.current.delete(comment.id);
      });
  }, [api, markThreadStale, patchComment, postId, reportUpdateFailure, requireSignIn]);

  const heartComment = useCallback((comment: PostComment) => {
    // The heart waits on its own answer only: the creator's like on the same
    // comment, still on its way, does not hold it back.
    if (updatingIdsRef.current.has(comment.id)) return;
    updatingIdsRef.current.add(comment.id);
    const hearted = !comment.hearted;
    haptic.select();
    patchComment(comment, (current) => ({ ...current, hearted }));
    api.updatePostComment(postId, comment.id, { hearted })
      .then((response) => {
        patchComment(comment, () => response.comment);
        markThreadStale();
        AccessibilityInfo.announceForAccessibility(hearted ? 'Comment hearted.' : 'Heart removed.');
      })
      .catch((error: unknown) => {
        patchComment(comment, (current) => ({ ...current, hearted: Boolean(comment.hearted) }));
        reportUpdateFailure(error, 'heart');
      })
      .finally(() => {
        updatingIdsRef.current.delete(comment.id);
      });
  }, [api, markThreadStale, patchComment, postId, reportUpdateFailure]);

  const pinComment = useCallback((comment: PostComment) => {
    const pinned = !comment.pinned;
    api.updatePostComment(postId, comment.id, { pinned })
      .then((response) => {
        patchComment(comment, () => response.comment);
        // The pin a post holds moved: the comment it left reads unpinned at once.
        if (response.unpinnedCommentId) {
          const left = response.unpinnedCommentId;
          queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
            commentsQueryKey,
            (current) => mapCommentInPages(current, left, (item) => ({ ...item, pinned: false }))
          );
          setPendingTopLevel((current) => mapCommentInList(current, left, (item) => ({ ...item, pinned: false })));
        }
        haptic.success();
        AccessibilityInfo.announceForAccessibility(pinned ? 'Comment pinned.' : 'Comment unpinned.');
        // The pinned comment leads the thread and no offset counts it, so a pin
        // moves every later offset: the first page is kept and the rest read
        // again. The comment itself is moved to the head of that page first, so
        // it leads the thread from this moment, whatever becomes of the read.
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => keepFirstCommentPage(
            response.comment.pinned ? leadCommentPagesWith(current, response.comment) : current
          )
        );
        markThreadStale();
        void commentsQuery.refetch();
      })
      .catch((error: unknown) => {
        reportUpdateFailure(error, 'pin');
      });
  }, [api, commentsQuery, commentsQueryKey, markThreadStale, patchComment, postId, queryClient, reportUpdateFailure]);

  // An edit borrows the composer. Leaving it for something else never loses
  // words without a question: an edit with changes asks before they go.
  const leaveEditThen = useCallback((proceed: () => void) => {
    if (!hasUnsavedCommentEdit(draftRef.current, editing)) {
      proceed();
      return;
    }
    void showConfirmDialog({
      title: 'Discard your changes?',
      message: 'The changes to your comment have not been saved.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) proceed();
    });
  }, [editing]);

  const startReply = useCallback((comment: PostComment) => {
    if (!requireSignIn(comment)) return;
    leaveEditThen(() => {
      // Out of an edit, the reply starts from what the composer held before
      // it: an edit's own words are not a reply's draft.
      const base = editing
        ? { draft: heldComposer?.draft ?? '', replyPrefix: heldComposer?.replyPrefix ?? '' }
        : { draft: draftRef.current, replyPrefix };
      setEditing(null);
      setHeldComposer(null);
      setReplyTo(comment);
      // A reply to a reply opens by naming who it answers.
      setDraft(draftForReplyTarget(base.draft, base.replyPrefix, comment));
      setReplyPrefix(buildReplyDraftPrefix(comment));
      composerRef.current?.focus();
    });
  }, [editing, heldComposer, leaveEditThen, replyPrefix, requireSignIn]);

  const startEdit = useCallback((comment: PostComment) => {
    if (editing?.id === comment.id) {
      composerRef.current?.focus();
      return;
    }
    leaveEditThen(() => {
      // A comment or reply being written is put aside, not thrown away: it
      // comes back when this edit is saved or cancelled.
      if (!editing) setHeldComposer({ draft: draftRef.current, replyTo, replyPrefix });
      setReplyTo(null);
      setReplyPrefix('');
      setEditing(comment);
      setDraft(comment.body);
      composerRef.current?.focus();
    });
  }, [editing, leaveEditThen, replyPrefix, replyTo]);

  /** Ends an edit, saved or cancelled, and gives the composer back what it held. */
  const leaveEdit = useCallback(() => {
    setDraft(heldComposer?.draft ?? '');
    setReplyTo(heldComposer?.replyTo ?? null);
    setReplyPrefix(heldComposer?.replyPrefix ?? '');
    setHeldComposer(null);
    setEditing(null);
  }, [heldComposer]);

  // Cancel leaves a reply's own words in the field, as it always has, and
  // takes away what the composer itself put there: a handle, or the words of
  // the comment being edited, in whose place the draft it interrupted returns.
  const cancelComposerMode = useCallback(() => {
    if (editing) {
      leaveEdit();
      return;
    }
    setDraft((current) => (current === replyPrefix ? '' : current));
    setReplyTo(null);
    setReplyPrefix('');
  }, [editing, leaveEdit, replyPrefix]);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    if (!requireSignIn(replyTo)) return;

    if (editing) {
      const target = editing;
      setSubmitting(true);
      try {
        const response = await api.updatePostComment(postId, target.id, { body });
        patchComment(target, () => response.comment);
        leaveEdit();
        markThreadStale();
        AccessibilityInfo.announceForAccessibility('Comment edited.');
      } catch (error) {
        reportUpdateFailure(error, 'edit');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // The product exposes one reply level. Normalizing here also protects
    // restored/stale reply targets while the server enforces the same rule.
    const replyTarget = replyTo;
    const parentId = replyTarget
      ? replyTarget.parentId ?? replyTarget.id
      : null;
    setSubmitting(true);
    try {
      const response = await api.createPostComment(postId, { body, parentId, deliveryId });
      setDraft('');
      setReplyTo(null);
      setReplyPrefix('');

      if (parentId) {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => suspendCommentPagination(
            incrementParentReplyCountInPages(current, parentId, 1, response.commentCount)
          )
        );
        const repliesKey = createPostCommentRepliesQueryKey(postId, parentId, user?.id);
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          repliesKey,
          (current) => appendReplyToPages(current, response.comment, response.commentCount)
        );
        setPendingRepliesByParent((current) => ({
          ...current,
          [parentId]: [
            ...(current[parentId] ?? []).filter((comment) => comment.id !== response.comment.id),
            response.comment,
          ],
        }));
        // A pinned parent may sit on no loaded page; its own copy counts the reply.
        setPendingTopLevel((current) => incrementReplyCountInList(current, parentId, 1));
        setExpandedIds((current) => new Set(current).add(parentId));
        markThreadStale();
        void commentsQuery.refetch();
      } else {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => keepFirstCommentPage(
            prependCommentToPages(current, response.comment, response.commentCount)
          )
        );
        setPendingTopLevel((current) => [
          response.comment,
          ...current.filter((comment) => comment.id !== response.comment.id),
        ]);
        markThreadStale();
        void commentsQuery.refetch();
      }

      publishCommentCount(response.commentCount);
    } catch (error) {
      haptic.error();
      const copy = getCommentPostErrorCopy(error, Boolean(parentId));
      if (copy.signIn) {
        void showConfirmDialog({ title: copy.title, message: copy.message, confirmLabel: 'Sign in' })
          .then((confirmed) => {
            if (confirmed) openSignIn(replyTarget);
          });
      } else {
        showMessageDialog({ title: copy.title, message: copy.message });
      }
    } finally {
      setSubmitting(false);
    }
  }, [api, commentsQuery, commentsQueryKey, deliveryId, draft, editing, leaveEdit, markThreadStale, openSignIn, patchComment, postId, publishCommentCount, queryClient, replyTo, reportUpdateFailure, requireSignIn, submitting, user?.id]);

  const removeComment = useCallback((comment: PostComment, asOwner: boolean) => {
    void showConfirmDialog({
      ...getRemoveCommentConfirmation(comment, asOwner),
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        const response = await api.deletePostComment(postId, comment.id);
        if (comment.parentId) {
          const repliesKey = createPostCommentRepliesQueryKey(postId, comment.parentId, user?.id);
          queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
            repliesKey,
            (current) => suspendCommentPagination(
              markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
            )
          );
          setPendingRepliesByParent((current) => ({
            ...current,
            [comment.parentId!]: (current[comment.parentId!] ?? [])
              .filter((reply) => reply.id !== comment.id),
          }));
          queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
            commentsQueryKey,
            (current) => suspendCommentPagination(
              incrementParentReplyCountInPages(
                current,
                comment.parentId!,
                -1,
                response.commentCount
              )
            )
          );
          setPendingTopLevel((current) => incrementReplyCountInList(current, comment.parentId!, -1));
          void queryClient.invalidateQueries({ queryKey: repliesKey, refetchType: 'active' });
        } else {
          queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
            commentsQueryKey,
            (current) => suspendCommentPagination(
              markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
            )
          );
          setPendingTopLevel((current) => markCommentRemovedInList(current, comment.id, response.status));
        }
        markThreadStale();
        void commentsQuery.refetch();
        publishCommentCount(response.commentCount);
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not remove comment', error);
      }
    });
  }, [api, commentsQuery, commentsQueryKey, markThreadStale, postId, publishCommentCount, queryClient, user?.id]);

  const submitReport = useCallback(async (comment: PostComment, reason: CommentReportReason) => {
    setReporting(true);
    try {
      await api.reportComment(comment.id, { reason });
      haptic.success();
      showMessageDialog({
        title: 'Thanks for the report',
        message: 'Our moderation team will take a look.',
      });
    } catch (error) {
      haptic.error();
      showErrorDialog('Could not report comment', error);
    } finally {
      setReporting(false);
    }
  }, [api]);

  const reportComment = useCallback((comment: PostComment) => {
    if (!requireSignIn() || reporting) return;
    // A second sheet, not a layer drawn inside the first: Action sheets is the
    // component for choices that follow an intentional action, and Modality
    // asks that the previous one be gone before this one arrives — the comment
    // options sheet has already closed itself by the time this opens.
    showActionSheet({
      title: 'Why are you reporting this?',
      message: 'Choose the closest reason so the moderation team can review it correctly.',
      actions: REPORT_REASONS.map((reason) => ({
        label: reason.label,
        onPress: () => void submitReport(comment, reason.value),
      })),
    });
  }, [reporting, requireSignIn, submitReport]);

  const blockAuthor = useCallback((comment: PostComment) => {
    const authorId = comment.author?.id;
    if (!authorId || !requireSignIn()) return;
    const { authorLabel } = getCommentDisplay(comment);
    void showConfirmDialog({
      title: `Block ${authorLabel}?`,
      message: 'Their posts and comments will be hidden, and neither of you will be able to follow the other.',
      confirmLabel: 'Block user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.blockUser(authorId);
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not block user', error);
        return;
      }
      setReplyTo((current) => (current?.author?.id === authorId ? null : current));
      // The server leaves a blocked author's comments out of every thread it
      // lists, so every cached thread is out of date, not only this one.
      for (const queryKey of ALL_POST_COMMENT_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
      takeOffHomeShelf(queryClient, { creatorId: authorId });
      AccessibilityInfo.announceForAccessibility(`${authorLabel} blocked.`);
    });
  }, [api, queryClient, requireSignIn]);

  // What a comment's ••• offers: a native menu on the ••• itself
  // (`lib/native-menu.ts`), and the same rows as an action sheet in a build
  // without native menus.
  const commentMenu = useCallback((comment: PostComment) => buildCommentMenu({
    canDelete: canDeleteComment(comment, user?.id),
    canRemove: canRemoveComment(comment, resolvedPostCreatorId, user?.id),
    canReport: canReportComment(comment, user?.id),
    block: canBlockCommentAuthor(comment, resolvedPostCreatorId, user?.id)
      ? { authorLabel: getCommentDisplay(comment).authorLabel, onBlock: () => blockAuthor(comment) }
      : null,
    canEdit: canEditComment(comment, user?.id),
    pin: canPinComment(comment, resolvedPostCreatorId, user?.id)
      ? { pinned: Boolean(comment.pinned), onToggle: () => pinComment(comment) }
      : null,
    onEdit: () => startEdit(comment),
    onDelete: () => removeComment(comment, false),
    onRemove: () => removeComment(comment, true),
    onReport: () => reportComment(comment),
  }), [blockAuthor, pinComment, removeComment, reportComment, resolvedPostCreatorId, startEdit, user?.id]);

  const rowActions = useMemo<CommentRowActions>(() => ({
    postCreatorId: resolvedPostCreatorId,
    viewerUserId: user?.id ?? null,
    onReact: reactToComment,
    onHeart: heartComment,
    onReply: startReply,
  }), [heartComment, reactToComment, resolvedPostCreatorId, startReply, user?.id]);

  const openCommentActions = useCallback((comment: PostComment) => {
    const menu = commentMenu(comment);
    if (!hasNativeMenuItems(menu)) return;
    // Alerts caps at three buttons and is for problems, not choices; this list
    // can reach four and follows straight from tapping the comment's own
    // control (Alerts: "Use an action sheet — not an alert — to offer choices
    // related to an intentional action").
    showActionSheet(actionSheetFromMenu('Comment options', menu));
  }, [commentMenu]);

  const hasCommentActions = useCallback(
    (comment: PostComment) => hasNativeMenuItems(commentMenu(comment)),
    [commentMenu]
  );

  const renderTopLevelComment = useCallback(({ item: comment }: { item: PostComment }) => {
    const expanded = expandedIds.has(comment.id);
    const repliesToggleLabel = getRepliesToggleLabel(comment.replyCount, expanded);
    return (
      <View>
        <CommentRowView
          comment={comment}
          actionsMenu={commentMenu}
          onActions={hasCommentActions(comment) ? openCommentActions : undefined}
          onAuthorOpen={openAuthorProfile}
          rowActions={rowActions}
        />
        {expanded ? (
          <RepliesList
            parentId={comment.id}
            pendingReplies={pendingRepliesByParent[comment.id] ?? []}
            postId={postId}
            hasActions={hasCommentActions}
            actionsMenu={commentMenu}
            onActions={openCommentActions}
            onAuthorOpen={openAuthorProfile}
            rowActions={rowActions}
          />
        ) : null}
        {comment.replyCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={repliesToggleLabel}
            accessibilityState={{ expanded }}
            onPress={() => toggleReplies(comment.id)}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              paddingLeft: appTheme.spacing.panel + 33,
              paddingRight: appTheme.spacing.panel,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              {repliesToggleLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [expandedIds, commentMenu, hasCommentActions, openAuthorProfile, openCommentActions, pendingRepliesByParent, postId, rowActions, toggleReplies]);

  const canSubmit = hasCommentToSend(draft, replyPrefix, editing ? editing.body : null)
    && !submitting
    && !commentsUnavailable;

  const focusComposer = useCallback(() => {
    if (!enabled || commentsUnavailable) return;
    if (!requireSignIn(replyTo)) return;
    composerRef.current?.focus();
  }, [commentsUnavailable, enabled, replyTo, requireSignIn]);

  const scrollToComments = useCallback((options: { focus?: boolean } = {}) => {
    commentsListRef.current?.scrollToOffset({
      offset: commentsOffsetRef.current,
      animated: !reducedMotion,
    });
    if (options.focus !== false) {
      requestAnimationFrame(focusComposer);
    }
  }, [focusComposer, reducedMotion]);

  useImperativeHandle(ref, () => ({ focusComposer, scrollToComments }), [focusComposer, scrollToComments]);

  const captureCommentsOffset = useCallback((event: LayoutChangeEvent) => {
    commentsOffsetRef.current = event.nativeEvent.layout.y;
  }, []);

  // Sorting nothing is noise, so the control comes with the first comment, as
  // on the web. Once the reader has picked New it stays while that order
  // loads (the count falls back to the card's until the first page answers),
  // so the way back to Top never leaves from under the finger.
  const showSort = enabled
    && !commentsUnavailable
    && (serverCommentCount > 0 || topLevel.length > 0 || sort !== DEFAULT_POST_COMMENT_SORT);

  const commentsHeader = (
    <View
      onLayout={presentation === 'inline' ? captureCommentsOffset : undefined}
      style={{
        borderTopWidth: presentation === 'inline' ? 8 : 0,
        borderTopColor: theme.colors.background,
        paddingHorizontal: appTheme.spacing.panel,
        paddingTop: presentation === 'inline' ? appTheme.spacing.panel : 0,
        paddingBottom: appTheme.spacing.compact,
        gap: 2,
      }}
    >
      {presentation === 'sheet' && postTitle ? (
        <Text numberOfLines={2} style={{ color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '800' }}>
          {postTitle}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
        <Text accessibilityRole="header" style={{ flex: 1, minWidth: 0, color: theme.colors.text, ...appTheme.type.cardTitle }}>
          {serverCommentCount > 0 ? `Comments · ${serverCommentCount}` : 'Comments'}
        </Text>
        {showSort ? <CommentSortControl value={sort} onChange={selectSort} /> : null}
      </View>
    </View>
  );

  const loadErrorState = loadError ? (
    <View style={{ padding: appTheme.spacing.panel, gap: appTheme.spacing.gap }}>
      <StatusBlock
        tone={loadError.canRetry ? 'danger' : 'neutral'}
        title={loadError.title}
        body={loadError.body}
      />
      {loadError.canRetry ? (
        <PrimaryButton
          label="Try again"
          accessibilityLabel="Try loading comments again"
          loading={commentsQuery.isRefetching}
          onPress={() => void commentsQuery.refetch()}
        />
      ) : null}
    </View>
  ) : null;

  const emptyState = !enabled && unavailableMessage ? (
    <View style={{ paddingVertical: appTheme.spacing.section, paddingHorizontal: appTheme.spacing.panel }}>
      <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
        {unavailableMessage}
      </Text>
    </View>
  ) : commentsUnavailable ? loadErrorState : commentsQuery.isLoading ? (
    <View style={{ paddingHorizontal: appTheme.spacing.panel, paddingVertical: appTheme.spacing.card }}>
      <CommentListSkeleton />
    </View>
  ) : (
    <View style={{ paddingVertical: appTheme.spacing.section, paddingHorizontal: appTheme.spacing.panel, gap: 4 }}>
      <Text style={{ color: theme.colors.text, ...appTheme.type.body, fontWeight: '800' }}>
        No comments yet
      </Text>
      <Text style={{ color: theme.colors.faint, ...appTheme.type.bodySm }}>
        Be the first to share what you think about this post.
      </Text>
    </View>
  );

  const list = (
    <FlatList
      ref={commentsListRef}
      data={commentsUnavailable || !enabled ? [] : topLevel}
      keyExtractor={(comment) => comment.id}
      renderItem={renderTopLevelComment}
      // In the sheet a tap on a comment answers with the keyboard up. Inline, on the post page, the
      // list also holds the post itself, whose creator link pushes a screen and whose Create slot
      // opens a Modal, neither checked on an iPhone with the keys up; so there the first tap only
      // puts the keyboard away, as before. The composer is outside the list and answers as its
      // page's scroller does.
      keyboardShouldPersistTaps={presentation === 'inline' ? 'never' : 'handled'}
      ListHeaderComponent={presentation === 'inline' ? (
        <>
          {contentHeader}
          {commentsHeader}
        </>
      ) : undefined}
      onRefresh={enabled && !commentsUnavailable ? () => {
        setPullRefreshing(true);
        void commentsQuery.refetch().finally(() => setPullRefreshing(false));
      } : undefined}
      refreshing={pullRefreshing}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (enabled && commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) {
          void commentsQuery.fetchNextPage();
        }
      }}
      ListEmptyComponent={emptyState}
      ListFooterComponent={commentsQuery.isFetchingNextPage ? (
        <View style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.faint} />
        </View>
      ) : null}
      contentContainerStyle={presentation === 'inline' ? { paddingBottom: appTheme.spacing.section } : undefined}
    />
  );

  const composer = enabled && !commentsClosed ? (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderStrong,
        backgroundColor: presentation === 'inline' ? theme.colors.app : 'transparent',
        paddingHorizontal: appTheme.spacing.panel,
        paddingTop: appTheme.spacing.gap,
        paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
        gap: appTheme.spacing.compact,
      }}
    >
      {replyTo || editing ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <Text numberOfLines={1} style={{ color: theme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {editing ? 'Editing your comment' : `Replying to ${getCommentDisplay(replyTo as PostComment).authorLabel}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Cancel edit' : 'Cancel reply'}
            onPress={cancelComposerMode}
            style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
        <TextInput
          ref={composerRef}
          accessibilityLabel={editing
            ? 'Edit your comment'
            : replyTo ? `Write a reply to ${getCommentDisplay(replyTo).authorLabel}` : 'Write a comment'}
          accessibilityHint={commentsUnavailable ? 'Retry loading comments before posting.' : undefined}
          value={draft}
          onChangeText={setDraft}
          editable={!submitting && !commentsUnavailable}
          maxLength={POST_COMMENT_MAX_LENGTH}
          multiline
          placeholder={replyTo
            ? 'Write a reply…'
            : presentation === 'inline'
              ? 'Join the conversation…'
              : 'Add a comment…'}
          placeholderTextColor={theme.colors.faint}
          onPressIn={() => { if (!user) requireSignIn(replyTo); }}
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            borderRadius: appTheme.radii.md,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderStrong,
            backgroundColor: theme.colors.surface,
            color: theme.colors.text,
            paddingHorizontal: appTheme.spacing.gap,
            paddingTop: 12,
            paddingBottom: 12,
            ...appTheme.type.bodySm,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save edit' : 'Post comment'}
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          onPress={() => void submitComment()}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: appTheme.radii.md,
            borderCurve: 'continuous',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canSubmit ? theme.colors.primaryFill : theme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {submitting ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            editing ? (
              <Check size={18} color={canSubmit ? theme.colors.onPrimary : theme.colors.faint} />
            ) : (
              <SendHorizontal
                size={18}
                color={canSubmit ? theme.colors.onPrimary : theme.colors.faint}
              />
            )
          )}
        </Pressable>
      </View>
    </View>
  ) : null;

  const panel = (
    <Animated.View
      style={presentation === 'sheet' ? {
        // The slide lives on the panel rather than a wrapper: an extra view in
        // between would become the percentage height's containing block, and an
        // auto-sized parent leaves `78%` with nothing to resolve against.
        transform: [{ translateY: sheetTranslateY }],
        height: '78%',
        borderTopLeftRadius: appTheme.radii.xl,
        borderTopRightRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderBottomWidth: 0,
        borderColor: theme.colors.borderStrong,
        backgroundColor: theme.colors.panel,
      } : {
        flex: 1,
        backgroundColor: theme.colors.app,
      }}
    >
      {presentation === 'sheet' ? (
        // The pull-to-dismiss covers the grabber and the title. Not the list,
        // which keeps its own scrolling, and not the composer, whose field
        // needs every touch it gets.
        <View {...sheetDrag.contentPanHandlers}>
          <SheetGrabber drag={sheetDrag} />
          {commentsHeader}
        </View>
      ) : null}
      {list}
      {composer}
    </Animated.View>
  );

  // In `sheet` presentation this surface is rendered through `OverlayHost`
  // rather than a `Modal`. That is load-bearing: a Modal is a separate window
  // on Android and receives neither the WindowInsetsAnimation the animated
  // tracker reads nor the JS `Keyboard` events — both measured returning
  // nothing from inside one — so the composer sat under the keyboard while you
  // typed into it. In the app's own window the avoidance below applies
  // normally.
  const keyboardSurface = (
    <KeyboardAvoidingArea
      style={{ justifyContent: presentation === 'sheet' ? 'flex-end' : 'flex-start' }}
    >
      {presentation === 'sheet' ? (
        <Animated.View style={{ position: 'absolute', inset: 0, opacity: backdropOpacity }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close comments"
            onPress={onClose}
            style={({ pressed }) => ({ flex: 1, backgroundColor: theme.colors.scrim, opacity: pressed ? appTheme.opacity.pressed : 1 })}
          />
        </Animated.View>
      ) : null}
      {panel}
    </KeyboardAvoidingArea>
  );

  if (presentation === 'inline') return keyboardSurface;

  return <Overlay visible={presented}>{keyboardSurface}</Overlay>;
});

const COMMENT_SORT_OPTIONS = POST_COMMENT_SORTS.map((option) => ({ value: option.id, label: option.label }));

/**
 * Top or New: the app's segmented control as tabs, each order sized to its
 * word, so the control fits beside the sheet's title.
 */
function CommentSortControl({ value, onChange }: { value: PostCommentSort; onChange: (sort: PostCommentSort) => void }) {
  return (
    <SegmentedControl
      role="tab"
      fill={false}
      accessibilityLabel="Sort comments"
      options={COMMENT_SORT_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}

export function CommentsSheet(props: Omit<PostCommentsProps, 'presentation' | 'enabled' | 'contentHeader' | 'unavailableMessage'> & {
  visible: boolean;
  onClose: () => void;
}) {
  return <PostComments {...props} enabled={props.visible} presentation="sheet" />;
}

function RepliesList({
  parentId,
  pendingReplies,
  postId,
  hasActions,
  actionsMenu,
  onActions,
  onAuthorOpen,
  rowActions,
}: {
  parentId: string;
  pendingReplies: PostComment[];
  postId: string;
  hasActions: (comment: PostComment) => boolean;
  actionsMenu: CommentMenuBuilder;
  onActions: CommentActionHandler;
  onAuthorOpen: AuthorOpenHandler;
  rowActions: CommentRowActions;
}) {
  const theme = useAppTheme();
  const { api, user } = useAuth();
  const repliesQuery = useInfiniteQuery({
    queryKey: createPostCommentRepliesQueryKey(postId, parentId, user?.id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listPostComments(
      postId,
      getCommentsPageParams({
        offset: pageParam as number,
        parentId,
        limit: POST_COMMENTS_PAGE_SIZE,
      })
    ),
    getNextPageParam: getNextCommentsPageOffset,
  });
  const replies = useMemo(
    () => mergeRepliesWithPending(repliesQuery.data?.pages, pendingReplies),
    [pendingReplies, repliesQuery.data?.pages]
  );

  if (repliesQuery.isLoading && !replies.length) {
    return (
      <View
        accessibilityLabel="Loading replies"
        style={{ minHeight: 48, paddingLeft: appTheme.spacing.panel + 33, justifyContent: 'center' }}
      >
        <ActivityIndicator color={theme.colors.faint} />
      </View>
    );
  }

  return (
    <View>
      {replies.map((reply) => (
        <CommentRowView
          key={reply.id}
          comment={reply}
          isReply
          actionsMenu={actionsMenu}
          onActions={hasActions(reply) ? onActions : undefined}
          onAuthorOpen={onAuthorOpen}
          rowActions={rowActions}
        />
      ))}
      {repliesQuery.isError ? (
        <View
          style={{
            paddingLeft: appTheme.spacing.panel + 33,
            paddingRight: appTheme.spacing.panel,
            paddingBottom: appTheme.spacing.compact,
            gap: appTheme.spacing.compact,
          }}
        >
          <Text accessibilityRole="alert" style={{ color: theme.semantic.danger.foreground, ...appTheme.type.caption }}>
            Some replies could not be loaded.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try loading replies again"
            onPress={() => void repliesQuery.refetch()}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              minHeight: 48,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              Try again
            </Text>
          </Pressable>
        </View>
      ) : null}
      {repliesQuery.hasNextPage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load more replies"
          accessibilityState={{ busy: repliesQuery.isFetchingNextPage }}
          disabled={repliesQuery.isFetchingNextPage}
          onPress={() => void repliesQuery.fetchNextPage()}
          style={({ pressed }) => ({
            minHeight: 48,
            justifyContent: 'center',
            paddingLeft: appTheme.spacing.panel + 33,
            paddingRight: appTheme.spacing.panel,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {repliesQuery.isFetchingNextPage ? (
            <ActivityIndicator color={theme.colors.faint} />
          ) : (
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              Load more replies
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function CommentRowView({
  comment,
  isReply = false,
  actionsMenu,
  onActions,
  onAuthorOpen,
  rowActions,
}: {
  comment: PostComment;
  isReply?: boolean;
  /** The ••• menu; `onActions` opens the action sheet where native menus are missing. */
  actionsMenu?: CommentMenuBuilder;
  onActions?: CommentActionHandler;
  onAuthorOpen?: AuthorOpenHandler;
  rowActions: CommentRowActions;
}) {
  const theme = useAppTheme();
  const display = getCommentDisplay(comment);
  // A long comment opens folded to four lines, so one essay cannot push the
  // rest of the thread off the sheet.
  const foldable = !display.isDeleted && isLongComment(display.bodyText);
  const [unfolded, setUnfolded] = useState(false);
  const liked = comment.viewerReaction === 'like';
  const disliked = comment.viewerReaction === 'dislike';
  const likeCountLabel = getCommentLikeCountLabel(comment);
  const mayHeart = canHeartComment(comment, rowActions.postCreatorId, rowActions.viewerUserId);
  // A removed comment has no author, and the profile route needs a handle.
  const authorUsername = display.isDeleted ? null : comment.author?.username ?? null;
  // Their page is read once the finger has rested on either (`creatorProfilePress`).
  const authorPress = authorUsername && onAuthorOpen
    ? creatorProfilePress(authorUsername, () => onAuthorOpen(authorUsername))
    : null;
  const avatar = <CreatorAvatar uri={comment.author?.avatarUrl ?? null} name={display.authorLabel} size={25} />;
  const authorName = (
    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
      {display.authorLabel}
    </Text>
  );

  return (
    <View>
      {comment.pinned && !display.isDeleted ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: appTheme.spacing.panel,
            paddingTop: appTheme.spacing.gap,
          }}
        >
          <Pin size={14} color={theme.colors.faint} />
          <Text style={{ color: theme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>
            {PINNED_COMMENT_LABEL}
          </Text>
        </View>
      ) : null}
    <View
      style={{
        flexDirection: 'row',
        gap: appTheme.spacing.compact,
        paddingLeft: appTheme.spacing.panel + (isReply ? 33 : 0),
        paddingRight: appTheme.spacing.panel,
        paddingVertical: appTheme.spacing.gap,
      }}
    >
      {authorPress ? (
        // The avatar takes the handle's tap, with room around it for a 44pt
        // target. The handle is the one control a screen reader lists, so this
        // one stays out of its way.
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          hitSlop={10}
          {...authorPress}
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          {avatar}
        </Pressable>
      ) : avatar}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          {authorPress ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${display.authorLabel} profile`}
              // Up into the row's padding, and down no further than the gap
              // above the comment, so a tap on its text never opens the profile.
              hitSlop={{ top: appTheme.spacing.gap, bottom: 3 }}
              {...authorPress}
              style={({ pressed }) => ({ flexShrink: 1, opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              {authorName}
            </Pressable>
          ) : authorName}
          {isPostCreatorComment(comment, rowActions.postCreatorId) ? (
            <View
              style={{
                borderRadius: appTheme.radii.pill,
                backgroundColor: theme.colors.surfaceStrong,
                paddingHorizontal: 6,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800' }}>
                Creator
              </Text>
            </View>
          ) : null}
          <Text style={{ color: theme.colors.faint, ...appTheme.type.caption }}>{display.timeLabel}</Text>
        </View>
        <Text
          numberOfLines={foldable && !unfolded ? 4 : undefined}
          style={{
            color: display.isDeleted ? theme.colors.faint : theme.colors.text,
            ...appTheme.type.bodySm,
            fontStyle: display.isDeleted ? 'italic' : 'normal',
          }}
        >
          {display.bodyText}
        </Text>
        {foldable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={unfolded ? 'Show less of this comment' : 'Read more of this comment'}
            accessibilityState={{ expanded: unfolded }}
            onPress={() => setUnfolded((current) => !current)}
            // One line of text under the comment it belongs to, with the reach of a button.
            hitSlop={verticalHitSlop(28)}
            style={({ pressed }) => ({ minHeight: 28, alignSelf: 'flex-start', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '800' }}>
              {unfolded ? 'Show less' : 'Read more'}
            </Text>
          </Pressable>
        ) : null}
        {!display.isDeleted ? (
          // Like with its count, Dislike with none (the server never sends
          // one), the creator's heart, Reply: the web thread's row.
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: -10 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Like ${display.authorLabel}'s comment`}
              accessibilityValue={{ text: likeCountLabel ? `${likeCountLabel} likes` : 'No likes' }}
              accessibilityState={{ selected: liked }}
              onPress={() => rowActions.onReact(comment, 'like')}
              style={({ pressed }) => ({
                minWidth: 48,
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                // From the left, so the thumb sits in one column down the
                // thread whether or not a count follows it.
                justifyContent: 'flex-start',
                gap: 6,
                paddingHorizontal: 10,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <ThumbsUp
                size={16}
                color={liked ? theme.colors.text : theme.colors.faint}
                fill={liked ? theme.colors.text : 'none'}
              />
              {likeCountLabel ? (
                <Text style={{ color: liked ? theme.colors.text : theme.colors.faint, ...appTheme.type.caption, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                  {likeCountLabel}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dislike ${display.authorLabel}'s comment`}
              accessibilityState={{ selected: disliked }}
              onPress={() => rowActions.onReact(comment, 'dislike')}
              style={({ pressed }) => ({
                width: 48,
                minHeight: 48,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <ThumbsDown
                size={16}
                color={disliked ? theme.colors.text : theme.colors.faint}
                fill={disliked ? theme.colors.text : 'none'}
              />
            </Pressable>
            {mayHeart ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Heart ${display.authorLabel}'s comment`}
                accessibilityState={{ selected: Boolean(comment.hearted) }}
                onPress={() => rowActions.onHeart(comment)}
                style={({ pressed }) => ({
                  width: 48,
                  minHeight: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <Heart
                  size={16}
                  color={comment.hearted ? theme.colors.primary : theme.colors.faint}
                  fill={comment.hearted ? theme.colors.primary : 'none'}
                />
              </Pressable>
            ) : comment.hearted ? (
              <View
                accessible
                accessibilityLabel={HEARTED_COMMENT_LABEL}
                style={{ width: 36, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
              >
                <Heart size={16} color={theme.colors.primary} fill={theme.colors.primary} />
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reply to ${display.authorLabel}`}
              onPress={() => rowActions.onReply(comment)}
              style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: theme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>Reply</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {!display.isDeleted && onActions ? (
        <NativeMenu
          model={actionsMenu ? actionsMenu(comment) : { quickActions: [], sections: [] }}
          accessibilityLabel={`Options for ${display.authorLabel}'s comment`}
          trigger={{ width: 48, height: 48, iconSize: 16, iconColor: theme.colors.faint }}
          onFallbackPress={() => onActions(comment)}
          renderButton={(onPress) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Options for ${display.authorLabel}'s comment`}
              onPress={onPress}
              style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <MoreHorizontal size={16} color={theme.colors.faint} />
            </Pressable>
          )}
        />
      ) : null}
    </View>
    </View>
  );
}
