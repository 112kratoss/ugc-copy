import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { MoreHorizontal, SendHorizontal } from 'lucide-react-native';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, FlatList, type LayoutChangeEvent, Platform, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NativeMenu } from '@/components/native-menu';
import { CommentListSkeleton } from '@/components/skeleton';
import { CreatorAvatar, StatusBlock } from '@/components/ui';
import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import {
  ALL_POST_COMMENT_QUERY_KEYS,
  DEFAULT_POST_COMMENT_SORT,
  POST_COMMENTS_PAGE_SIZE,
  POST_COMMENT_MAX_LENGTH,
  POST_COMMENT_SORTS,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  applyCommentCountToSourceData,
  appendReplyToPages,
  canBlockCommentAuthor,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  createPostCommentsThreadQueryKey,
  getCommentAuthReturnTo,
  getCommentDisplay,
  getCommentPostErrorCopy,
  getCommentsLoadErrorCopy,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  getRemoveCommentConfirmation,
  getRepliesToggleLabel,
  incrementParentReplyCountInPages,
  incrementReplyCountInList,
  keepFirstCommentPage,
  markCommentRemovedInList,
  markCommentRemovedInPages,
  mergeRepliesWithPending,
  mergeTopLevelWithPending,
  prependCommentToPages,
  suspendCommentPagination,
  type PostCommentSort,
} from '@/lib/comments-view-model';
import { buildCommentMenu } from '@/lib/comment-menu';
import { useReducedMotion } from '@/lib/motion';
import { actionSheetFromMenu, hasNativeMenuItems, type NativeMenuModel } from '@/lib/native-menu';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { resolvedBottomInset } from '@/lib/safe-area';
import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { Overlay } from '@/components/overlay-host';
import { SheetGrabber, useSheetDismissDrag } from '@/components/sheet-chrome';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { CommentReportReason } from '@/lib/api-client';
import type {
  OwnerPostsResponse,
  PostComment,
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

  // A visible Modal used to consume the back key before any listener ran. The
  // sheet is an ordinary view now, so it has to claim the key itself — gated on
  // being open so the screen underneath keeps it the rest of the time.
  useHardwareBack(visible && presentation === 'sheet', onClose);

  // The Modal this replaced animated itself with `animationType="slide"`. An
  // overlay is an ordinary view, so the sheet owns that motion now — including
  // staying mounted through its exit, which a bare `visible` unmount would cut
  // off mid-flight.
  const { height: windowHeight } = useWindowDimensions();
  const [presented, setPresented] = useState(visible);
  const slide = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setPresented(true);
  }, [visible]);

  useEffect(() => {
    if (!presented || presentation !== 'sheet') return;

    if (reducedMotion) {
      slide.setValue(visible ? 1 : 0);
      if (!visible) setPresented(false);
      return;
    }

    const animation = Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: visible ? 280 : 200,
      // Decelerate in, accelerate out: the sheet arrives settling and leaves
      // like it was let go.
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setPresented(false);
    });

    return () => animation.stop();
  }, [presentation, presented, reducedMotion, slide, visible]);

  // The drag rides on top of the slide translation, which is why this one folds
  // the offset into its own transform instead of appending a second one.
  const sheetDrag = useSheetDismissDrag({ onDismiss: onClose, visible });
  // The scrim thins as the sheet is pulled away, on top of its own entrance.
  const backdropOpacity = sheetDrag.backdropOpacity && typeof Animated.multiply === 'function'
    ? Animated.multiply(slide, sheetDrag.backdropOpacity)
    : slide;


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
    setDraft('');
    setReplyTo(null);
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
    onClose();
    router.push({
      pathname: '/auth',
      params: {
        returnTo: getCommentAuthReturnTo(authReturnTo, postId, rootReplyId),
      },
    } as never);
  }, [authReturnTo, onClose, postId]);

  const requireSignIn = useCallback((replyComment?: PostComment | null) => {
    if (user) return true;
    openSignIn(replyComment);
    return false;
  }, [openSignIn, user]);

  const openAuthorProfile = useCallback((username: string) => {
    // Left open, the sheet would still cover the post when the reader comes
    // back from the profile, so it closes first, as it does for sign-in.
    if (presentation === 'sheet') onClose();
    router.push(`/creators/${encodeURIComponent(username)}` as never);
  }, [onClose, presentation]);

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

  const selectSort = useCallback((next: PostCommentSort) => {
    if (next === sort) return;
    haptic.select();
    setSortChoice({ postId, sort: next });
    // In the sheet the control sits above the list, which may be scrolled
    // far down the old order; the new one is read from its start. On the
    // post page the control is in the list's own header, already in view.
    if (presentation === 'sheet') {
      commentsListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [postId, presentation, sort]);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    if (!requireSignIn(replyTo)) return;

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
  }, [api, commentsQuery, commentsQueryKey, deliveryId, draft, markThreadStale, openSignIn, postId, publishCommentCount, queryClient, replyTo, requireSignIn, submitting, user?.id]);

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
    onDelete: () => removeComment(comment, false),
    onRemove: () => removeComment(comment, true),
    onReport: () => reportComment(comment),
  }), [blockAuthor, removeComment, reportComment, resolvedPostCreatorId, user?.id]);

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
          onReply={(nextComment) => {
            if (requireSignIn(nextComment)) setReplyTo(nextComment);
          }}
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
  }, [expandedIds, commentMenu, hasCommentActions, openAuthorProfile, openCommentActions, pendingRepliesByParent, postId, requireSignIn, toggleReplies]);

  const canSubmit = draft.trim().length > 0 && !submitting && !commentsUnavailable;

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try loading comments again"
          accessibilityState={{ busy: commentsQuery.isRefetching }}
          disabled={commentsQuery.isRefetching}
          onPress={() => void commentsQuery.refetch()}
          style={({ pressed }) => ({
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: appTheme.radii.md,
            backgroundColor: theme.colors.primaryFill,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {commentsQuery.isRefetching ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={{ color: theme.colors.onPrimary, ...appTheme.type.bodySm, fontWeight: '800' }}>
              Try again
            </Text>
          )}
        </Pressable>
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
      keyboardShouldPersistTaps="handled"
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
      {replyTo ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <Text numberOfLines={1} style={{ color: theme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {`Replying to ${getCommentDisplay(replyTo).authorLabel}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            onPress={() => setReplyTo(null)}
            style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
        <TextInput
          ref={composerRef}
          accessibilityLabel={replyTo ? `Write a reply to ${getCommentDisplay(replyTo).authorLabel}` : 'Write a comment'}
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
          accessibilityLabel="Post comment"
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
            <SendHorizontal
              size={18}
              color={canSubmit ? theme.colors.onPrimary : theme.colors.faint}
            />
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
        transform: [{
          translateY: sheetDrag.translateY
            ? Animated.add(
                slide.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }),
                sheetDrag.translateY,
              )
            : slide.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }),
        }],
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

/**
 * Top or New, drawn as the app's segmented control (`ProfileSegment`, the
 * creator page's tabs): a track with a solid fill on the order in use, each
 * order a tab at the 48pt touch height.
 */
function CommentSortControl({ value, onChange }: { value: PostCommentSort; onChange: (sort: PostCommentSort) => void }) {
  const theme = useAppTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Sort comments"
      style={{
        flexDirection: 'row',
        gap: 4,
        padding: 4,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceInset,
      }}
    >
      {POST_COMMENT_SORTS.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.id)}
            style={({ pressed }) => ({
              minWidth: 56,
              minHeight: appTheme.touch.compact,
              paddingHorizontal: appTheme.spacing.gap,
              borderRadius: 14,
              borderCurve: 'continuous',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? theme.colors.primaryFill : 'transparent',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? theme.colors.onPrimary : theme.colors.muted, ...appTheme.type.label }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
}: {
  parentId: string;
  pendingReplies: PostComment[];
  postId: string;
  hasActions: (comment: PostComment) => boolean;
  actionsMenu: CommentMenuBuilder;
  onActions: CommentActionHandler;
  onAuthorOpen: AuthorOpenHandler;
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
  onReply,
}: {
  comment: PostComment;
  isReply?: boolean;
  /** The ••• menu; `onActions` opens the action sheet where native menus are missing. */
  actionsMenu?: CommentMenuBuilder;
  onActions?: CommentActionHandler;
  onAuthorOpen?: AuthorOpenHandler;
  onReply?: CommentActionHandler;
}) {
  const theme = useAppTheme();
  const display = getCommentDisplay(comment);
  // A removed comment has no author, and the profile route needs a handle.
  const authorUsername = display.isDeleted ? null : comment.author?.username ?? null;
  const openAuthor = authorUsername && onAuthorOpen ? () => onAuthorOpen(authorUsername) : undefined;
  const avatar = <CreatorAvatar uri={comment.author?.avatarUrl ?? null} name={display.authorLabel} size={25} />;
  const authorName = (
    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
      {display.authorLabel}
    </Text>
  );

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: appTheme.spacing.compact,
        paddingLeft: appTheme.spacing.panel + (isReply ? 33 : 0),
        paddingRight: appTheme.spacing.panel,
        paddingVertical: appTheme.spacing.gap,
      }}
    >
      {openAuthor ? (
        // The avatar takes the handle's tap, with room around it for a 44pt
        // target. The handle is the one control a screen reader lists, so this
        // one stays out of its way.
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          hitSlop={10}
          onPress={openAuthor}
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          {avatar}
        </Pressable>
      ) : avatar}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          {openAuthor ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${display.authorLabel} profile`}
              // Up into the row's padding, and down no further than the gap
              // above the comment, so a tap on its text never opens the profile.
              hitSlop={{ top: appTheme.spacing.gap, bottom: 3 }}
              onPress={openAuthor}
              style={({ pressed }) => ({ flexShrink: 1, opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              {authorName}
            </Pressable>
          ) : authorName}
          <Text style={{ color: theme.colors.faint, ...appTheme.type.caption }}>{display.timeLabel}</Text>
        </View>
        <Text
          style={{
            color: display.isDeleted ? theme.colors.faint : theme.colors.text,
            ...appTheme.type.bodySm,
            fontStyle: display.isDeleted ? 'italic' : 'normal',
          }}
        >
          {display.bodyText}
        </Text>
        {!display.isDeleted && onReply ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${display.authorLabel}`}
            onPress={() => onReply(comment)}
            style={({ pressed }) => ({ minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: theme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>Reply</Text>
          </Pressable>
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
  );
}
