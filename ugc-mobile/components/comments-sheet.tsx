import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router } from 'expo-router';
import { MoreHorizontal, SendHorizontal } from 'lucide-react-native';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, type LayoutChangeEvent, Platform, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentListSkeleton } from '@/components/skeleton';
import { CreatorAvatar, StatusBlock } from '@/components/ui';
import { showActionSheet, type ActionSheetAction } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import {
  POST_COMMENTS_PAGE_SIZE,
  POST_COMMENT_MAX_LENGTH,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  applyCommentCountToSourceData,
  appendReplyToPages,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  flattenCommentPages,
  getCommentAuthReturnTo,
  getCommentDisplay,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  incrementParentReplyCountInPages,
  keepFirstCommentPage,
  markCommentRemovedInPages,
  mergeRepliesWithPending,
  prependCommentToPages,
  suspendCommentPagination,
  type PostCommentSort,
} from '@/lib/comments-view-model';
import { useReducedMotion } from '@/lib/motion';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { resolvedBottomInset } from '@/lib/safe-area';
import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { Overlay } from '@/components/overlay-host';
import { SheetGrabber, useSheetDismissDrag } from '@/components/sheet-chrome';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { appTheme } from '@/lib/theme';
import type { CommentReportReason } from '@/lib/api-client';
import type {
  OwnerPostsResponse,
  PostComment,
  PostCommentsResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';

const REPORT_REASONS: Array<{ label: string; value: CommentReportReason }> = [
  { label: 'Spam or misleading', value: 'spam' },
  { label: 'Harassment or bullying', value: 'harassment' },
  { label: 'Unsafe content', value: 'unsafe_content' },
  { label: 'Something else', value: 'other' },
];

type CommentActionHandler = (comment: PostComment) => void;

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
}, ref) {
  const reducedMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const { api, user } = useAuth();
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);

  const [sort] = useState<PostCommentSort>('top');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [pendingRepliesByParent, setPendingRepliesByParent] = useState<Record<string, PostComment[]>>({});
  const [reporting, setReporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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
    () => flattenCommentPages(commentsQuery.data?.pages),
    [commentsQuery.data?.pages]
  );

  useEffect(() => {
    setDraft('');
    setReplyTo(null);
    setExpandedIds(new Set());
    setPendingRepliesByParent({});
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

  const requireSignIn = useCallback((replyComment?: PostComment | null) => {
    if (user) return true;
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
    return false;
  }, [authReturnTo, onClose, postId, user]);

  const toggleReplies = useCallback((parentId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);

  const submitComment = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    if (!requireSignIn(replyTo)) return;

    setSubmitting(true);
    try {
      // The product exposes one reply level. Normalizing here also protects
      // restored/stale reply targets while the server enforces the same rule.
      const parentId = replyTo
        ? replyTo.parentId ?? replyTo.id
        : null;
      const response = await api.createPostComment(postId, { body, parentId });
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
        setExpandedIds((current) => new Set(current).add(parentId));
        void commentsQuery.refetch();
      } else {
        queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
          commentsQueryKey,
          (current) => keepFirstCommentPage(
            prependCommentToPages(current, response.comment, response.commentCount)
          )
        );
        void commentsQuery.refetch();
      }

      publishCommentCount(response.commentCount);
    } catch (error) {
      haptic.error();
      showErrorDialog('Could not post comment', error);
    } finally {
      setSubmitting(false);
    }
  }, [api, commentsQuery, commentsQueryKey, draft, postId, publishCommentCount, queryClient, replyTo, requireSignIn, submitting, user?.id]);

  const removeComment = useCallback((comment: PostComment, asOwner: boolean) => {
    void showConfirmDialog({
      title: asOwner ? 'Remove this comment?' : 'Delete your comment?',
      message: asOwner
        ? 'It will be hidden from everyone viewing your post.'
        : 'Your comment will be replaced with “[deleted]”. Replies to it stay visible.',
      confirmLabel: asOwner ? 'Remove' : 'Delete',
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
          void queryClient.invalidateQueries({ queryKey: repliesKey, refetchType: 'active' });
        } else {
          queryClient.setQueryData<InfiniteData<PostCommentsResponse>>(
            commentsQueryKey,
            (current) => suspendCommentPagination(
              markCommentRemovedInPages(current, comment.id, response.status, response.commentCount)
            )
          );
        }
        void commentsQuery.refetch();
        publishCommentCount(response.commentCount);
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not remove comment', error);
      }
    });
  }, [api, commentsQuery, commentsQueryKey, postId, publishCommentCount, queryClient, user?.id]);

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

  const openCommentActions = useCallback((comment: PostComment) => {
    const options: ActionSheetAction[] = [];

    if (canDeleteComment(comment, user?.id)) {
      options.push({ label: 'Delete', destructive: true, onPress: () => removeComment(comment, false) });
    }
    if (canRemoveComment(comment, resolvedPostCreatorId, user?.id)) {
      options.push({ label: 'Remove from post', destructive: true, onPress: () => removeComment(comment, true) });
    }
    if (canReportComment(comment, user?.id)) {
      options.push({ label: 'Report', destructive: true, onPress: () => reportComment(comment) });
    }
    if (!options.length) return;

    // Alerts caps at three buttons and is for problems, not choices; this list
    // can reach four and follows straight from tapping the comment's own
    // control (Alerts: "Use an action sheet — not an alert — to offer choices
    // related to an intentional action").
    showActionSheet({ title: 'Comment options', actions: options });
  }, [removeComment, reportComment, resolvedPostCreatorId, user?.id]);

  const hasCommentActions = useCallback((comment: PostComment) => (
    canDeleteComment(comment, user?.id)
    || canRemoveComment(comment, resolvedPostCreatorId, user?.id)
    || canReportComment(comment, user?.id)
  ), [resolvedPostCreatorId, user?.id]);

  const renderTopLevelComment = useCallback(({ item: comment }: { item: PostComment }) => {
    const expanded = expandedIds.has(comment.id);
    return (
      <View>
        <CommentRowView
          comment={comment}
          onActions={hasCommentActions(comment) ? openCommentActions : undefined}
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
            onActions={openCommentActions}
          />
        ) : null}
        {comment.replyCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide replies' : `View ${comment.replyCount} replies`}
            onPress={() => toggleReplies(comment.id)}
            style={({ pressed }) => ({
              minHeight: 48,
              justifyContent: 'center',
              paddingLeft: appTheme.spacing.panel + 33,
              paddingRight: appTheme.spacing.panel,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              {expanded
                ? 'Hide replies'
                : `View ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [expandedIds, hasCommentActions, openCommentActions, pendingRepliesByParent, postId, requireSignIn, toggleReplies]);

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

  const commentsHeader = (
    <View
      onLayout={presentation === 'inline' ? captureCommentsOffset : undefined}
      style={{
        borderTopWidth: presentation === 'inline' ? 8 : 0,
        borderTopColor: appTheme.colors.background,
        paddingHorizontal: appTheme.spacing.panel,
        paddingTop: presentation === 'inline' ? appTheme.spacing.panel : 0,
        paddingBottom: appTheme.spacing.compact,
        gap: 2,
      }}
    >
      {presentation === 'sheet' && postTitle ? (
        <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.caption, fontWeight: '800' }}>
          {postTitle}
        </Text>
      ) : null}
      <Text accessibilityRole="header" style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
        {serverCommentCount > 0 ? `Comments · ${serverCommentCount}` : 'Comments'}
      </Text>
    </View>
  );

  const retryState = (
    <View style={{ padding: appTheme.spacing.panel, gap: appTheme.spacing.gap }}>
      <StatusBlock
        tone="danger"
        title="Comments are unavailable"
        body="We could not load this conversation. Check your connection, then try again."
      />
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
          backgroundColor: appTheme.colors.primary,
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        {commentsQuery.isRefetching ? (
          <ActivityIndicator color={appTheme.colors.onPrimary} />
        ) : (
          <Text style={{ color: appTheme.colors.onPrimary, ...appTheme.type.bodySm, fontWeight: '800' }}>
            Try again
          </Text>
        )}
      </Pressable>
    </View>
  );

  const emptyState = !enabled && unavailableMessage ? (
    <View style={{ paddingVertical: appTheme.spacing.section, paddingHorizontal: appTheme.spacing.panel }}>
      <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
        {unavailableMessage}
      </Text>
    </View>
  ) : commentsUnavailable ? retryState : commentsQuery.isLoading ? (
    <View style={{ paddingHorizontal: appTheme.spacing.panel, paddingVertical: appTheme.spacing.card }}>
      <CommentListSkeleton />
    </View>
  ) : (
    <View style={{ paddingVertical: appTheme.spacing.section, paddingHorizontal: appTheme.spacing.panel, gap: 4 }}>
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.body, fontWeight: '800' }}>
        No comments yet
      </Text>
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.bodySm }}>
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
      onRefresh={enabled && !commentsUnavailable ? () => void commentsQuery.refetch() : undefined}
      refreshing={enabled && commentsQuery.isRefetching && !commentsQuery.isFetchingNextPage}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (enabled && commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) {
          void commentsQuery.fetchNextPage();
        }
      }}
      ListEmptyComponent={emptyState}
      ListFooterComponent={commentsQuery.isFetchingNextPage ? (
        <View style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={appTheme.colors.faint} />
        </View>
      ) : null}
      contentContainerStyle={presentation === 'inline' ? { paddingBottom: appTheme.spacing.section } : undefined}
    />
  );

  const composer = enabled ? (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: appTheme.colors.borderStrong,
        backgroundColor: presentation === 'inline' ? appTheme.colors.app : 'transparent',
        paddingHorizontal: appTheme.spacing.panel,
        paddingTop: appTheme.spacing.gap,
        paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
        gap: appTheme.spacing.compact,
      }}
    >
      {replyTo ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {`Replying to ${getCommentDisplay(replyTo).authorLabel}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            onPress={() => setReplyTo(null)}
            style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
        <TextInput
          ref={composerRef}
          accessibilityLabel="Write a comment"
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
          placeholderTextColor={appTheme.colors.faint}
          onPressIn={() => { if (!user) requireSignIn(replyTo); }}
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            borderRadius: appTheme.radii.md,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.borderStrong,
            backgroundColor: appTheme.colors.surface,
            color: appTheme.colors.text,
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
            backgroundColor: canSubmit ? appTheme.colors.primary : appTheme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {submitting ? (
            <ActivityIndicator color={appTheme.colors.onPrimary} />
          ) : (
            <SendHorizontal
              size={18}
              color={canSubmit ? appTheme.colors.onPrimary : appTheme.colors.faint}
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
        borderColor: appTheme.colors.borderStrong,
        backgroundColor: appTheme.colors.panel,
      } : {
        flex: 1,
        backgroundColor: appTheme.colors.app,
      }}
    >
      {presentation === 'sheet' ? (
        <>
          <SheetGrabber drag={sheetDrag} />
          {commentsHeader}
        </>
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
        <Animated.View style={{ position: 'absolute', inset: 0, opacity: slide }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close comments"
            onPress={onClose}
            style={({ pressed }) => ({ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', opacity: pressed ? appTheme.opacity.pressed : 1 })}
          />
        </Animated.View>
      ) : null}
      {panel}
    </KeyboardAvoidingArea>
  );

  if (presentation === 'inline') return keyboardSurface;

  return <Overlay visible={presented}>{keyboardSurface}</Overlay>;
});

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
  onActions,
}: {
  parentId: string;
  pendingReplies: PostComment[];
  postId: string;
  hasActions: (comment: PostComment) => boolean;
  onActions: CommentActionHandler;
}) {
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
        <ActivityIndicator color={appTheme.colors.faint} />
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
          onActions={hasActions(reply) ? onActions : undefined}
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
          <Text accessibilityRole="alert" style={{ color: appTheme.semantic.danger.foreground, ...appTheme.type.caption }}>
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
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
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
            <ActivityIndicator color={appTheme.colors.faint} />
          ) : (
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
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
  onActions,
  onReply,
}: {
  comment: PostComment;
  isReply?: boolean;
  onActions?: CommentActionHandler;
  onReply?: CommentActionHandler;
}) {
  const display = getCommentDisplay(comment);

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
      <CreatorAvatar uri={comment.author?.avatarUrl ?? null} name={display.authorLabel} size={25} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
          <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
            {display.authorLabel}
          </Text>
          <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>{display.timeLabel}</Text>
        </View>
        <Text
          style={{
            color: display.isDeleted ? appTheme.colors.faint : appTheme.colors.text,
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
            <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>Reply</Text>
          </Pressable>
        ) : null}
      </View>
      {!display.isDeleted && onActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Options for ${display.authorLabel}'s comment`}
          onPress={() => onActions(comment)}
          style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <MoreHorizontal size={16} color={appTheme.colors.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}
